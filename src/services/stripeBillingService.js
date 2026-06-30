import Stripe from 'stripe';
import { env } from '../config/env.js';
import { query } from '../db/postgres.js';
import { CREDIT_TYPES, recordStripePurchase, adjustCredits } from './creditService.js';

let stripeClient;
export function getStripe() {
  if (!env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY.');
  stripeClient ||= new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2025-11-17.clover' });
  return stripeClient;
}

export function requireStripeWebhookSecret() {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new Error('Stripe webhook signing is not configured. Set STRIPE_WEBHOOK_SECRET.');
  return env.STRIPE_WEBHOOK_SECRET;
}

export async function activeCreditPackages() {
  return (await query('select * from credit_packages where is_active = true order by sort_order, amount_cents')).rows;
}

export async function ensureStripeCustomer(user) {
  const existing = (await query('select * from stripe_customers where user_id = $1', [user.id])).rows[0];
  if (existing) return existing;
  const customer = await getStripe().customers.create({ email: user.email, metadata: { userId: user.id } });
  const saved = await query(
    `insert into stripe_customers (user_id, stripe_customer_id, email, metadata)
     values ($1,$2,$3,$4::jsonb)
     on conflict (user_id) do update set email = excluded.email
     returning *`,
    [user.id, customer.id, user.email, JSON.stringify({ stripeCreated: true })]
  );
  return saved.rows[0];
}

export async function createCheckoutSession({ user, packageId }) {
  const pkg = (await query('select * from credit_packages where id = $1 and is_active = true', [packageId])).rows[0];
  if (!pkg) throw new Error('Credit package is not available.');
  const customer = await ensureStripeCustomer(user);
  const successUrl = env.STRIPE_SUCCESS_URL || `${env.APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = env.STRIPE_CANCEL_URL || `${env.APP_URL}/billing/cancel`;
  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    customer: customer.stripe_customer_id,
    success_url: successUrl,
    cancel_url: cancelUrl,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: pkg.currency,
        unit_amount: pkg.amount_cents,
        product_data: { name: `${pkg.name} - ${pkg.credits.toLocaleString()} QuickRest credits` }
      }
    }],
    metadata: { userId: user.id, packageId: pkg.id, credits: String(pkg.credits) },
    client_reference_id: user.id
  });
  await query(
    `insert into stripe_checkout_sessions (user_id, stripe_customer_id, credit_package_id, stripe_session_id, status, payment_status, credits, amount_total_cents, currency, success_url, cancel_url, expires_at, metadata)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12),$13::jsonb)`,
    [user.id, customer.id, pkg.id, session.id, session.status || 'open', session.payment_status || 'unpaid', pkg.credits, pkg.amount_cents, pkg.currency, successUrl, cancelUrl, session.expires_at, JSON.stringify({ packageName: pkg.name })]
  );
  return { session, package: pkg };
}

async function markEvent(event, status, errorMessage = null, sessionDbId = null) {
  await query(`update stripe_webhook_events set processing_status=$2, error_message=$3, processed_at=case when $2 in ('processed','ignored') then now() else processed_at end, stripe_checkout_session_id=coalesce($4, stripe_checkout_session_id) where stripe_event_id=$1`, [event.id, status, errorMessage, sessionDbId]);
}

export async function processStripeEvent(event) {
  const inserted = await query(
    `insert into stripe_webhook_events (stripe_event_id, event_type, payload)
     values ($1,$2,$3::jsonb)
     on conflict (stripe_event_id) do nothing returning *`,
    [event.id, event.type, JSON.stringify(event)]
  );
  if (!inserted.rowCount) return { idempotent: true };
  try {
    const object = event.data?.object;
    let sessionRow = null;
    if (object?.object === 'checkout.session') {
      const updated = await query(
        `update stripe_checkout_sessions set status=$2, payment_status=$3, payment_intent_id=coalesce($4,payment_intent_id), completed_at=case when $2='complete' then coalesce(completed_at, now()) else completed_at end, failure_message=$5 where stripe_session_id=$1 returning *`,
        [object.id, object.status || (event.type === 'checkout.session.expired' ? 'expired' : 'open'), object.payment_status || 'unpaid', object.payment_intent || null, object.last_payment_error?.message || null]
      );
      sessionRow = updated.rows[0];
    }
    if (event.type === 'checkout.session.completed' && sessionRow && sessionRow.payment_status === 'paid') {
      await recordStripePurchase({ userId: sessionRow.user_id, credits: sessionRow.credits, stripeReference: sessionRow.stripe_session_id, idempotencyKey: `stripe:${event.id}`, metadata: { stripeEventId: event.id, checkoutSessionId: sessionRow.stripe_session_id, creditPackageId: sessionRow.credit_package_id } });
      await markEvent(event, 'processed', null, sessionRow.id);
      return { processed: true };
    }
    if (event.type === 'checkout.session.expired' && sessionRow) {
      await query(`update stripe_checkout_sessions set status='expired' where id=$1`, [sessionRow.id]);
      await markEvent(event, 'processed', null, sessionRow.id);
      return { processed: true };
    }
    if (event.type === 'payment_intent.payment_failed') {
      const updated = await query(`update stripe_checkout_sessions set status='failed', payment_status='failed', failure_message=$2 where payment_intent_id=$1 returning *`, [object.id, object.last_payment_error?.message || 'Payment failed']);
      await markEvent(event, updated.rowCount ? 'processed' : 'ignored', null, updated.rows[0]?.id || null);
      return { processed: Boolean(updated.rowCount) };
    }
    if (event.type === 'charge.refunded' || event.type === 'refund.created') {
      const paymentIntent = object.payment_intent;
      const session = (await query(`update stripe_checkout_sessions set status='refunded', payment_status='refunded', refunded_at=now() where payment_intent_id=$1 and refunded_at is null returning *`, [paymentIntent])).rows[0];
      if (session) await adjustCredits({ userId: session.user_id, amount: -session.credits, type: CREDIT_TYPES.REFUND, description: 'Stripe refund', stripeReference: object.id, idempotencyKey: `stripe:${event.id}`, metadata: { stripeEventId: event.id, paymentIntent } });
      await markEvent(event, session ? 'processed' : 'ignored', null, session?.id || null);
      return { processed: Boolean(session) };
    }
    await markEvent(event, 'ignored');
    return { ignored: true };
  } catch (error) {
    await markEvent(event, 'failed', error.message);
    throw error;
  }
}
