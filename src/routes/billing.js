import { Hono } from 'hono';
import { html } from 'hono/html';
import { getCookie } from 'hono/cookie';
import { requireAuth } from '../middleware/auth.js';
import { CSRF_COOKIE } from '../services/authService.js';
import { layout } from '../templates/layout.js';
import { activeCreditPackages, createCheckoutSession, getStripe, processStripeEvent, requireStripeWebhookSecret } from '../services/stripeBillingService.js';

export const billing = new Hono();

function escapeHtml(value = '') { return String(value).replace(/[&<>\"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' }[ch])); }
function render(c, title, children) { return c.html(html`${layout({ title, children, user: c.get('user') })}`); }
async function body(c) { return c.req.header('content-type')?.includes('application/json') ? c.req.json() : c.req.parseBody(); }
function csrfOk(c, data) { const token = getCookie(c, CSRF_COOKIE); return token && token === data.csrfToken; }

billing.post('/create-checkout-session', requireAuth, async (c) => {
  const data = await body(c);
  if (!csrfOk(c, data)) return c.json({ error: 'Invalid CSRF token' }, 403);
  try {
    const result = await createCheckoutSession({ user: c.get('user'), packageId: data.packageId });
    if ((c.req.header('accept') || '').includes('text/html')) return c.redirect(result.session.url, 303);
    return c.json({ checkoutUrl: result.session.url, sessionId: result.session.id }, 201);
  } catch (error) {
    return c.json({ error: error.message }, 400);
  }
});

billing.get('/success', requireAuth, async (c) => {
  const sessionId = c.req.query('session_id');
  let message = 'Payment received. Credits will appear as soon as Stripe confirms the checkout.';
  if (sessionId) {
    try {
      const session = await getStripe().checkout.sessions.retrieve(sessionId);
      message = session.payment_status === 'paid' ? 'Payment confirmed. Your credits are being applied.' : `Checkout status: ${escapeHtml(session.status || 'unknown')}.`;
    } catch { message = 'Payment returned from Stripe. We could not refresh the checkout status yet.'; }
  }
  return render(c, 'Billing success', `<div class="container py-5"><div class="alert alert-success"><h1 class="h4">Billing success</h1><p>${message}</p></div><a class="btn btn-primary" href="/credits">View credits and purchases</a></div>`);
});

billing.get('/cancel', requireAuth, (c) => render(c, 'Billing canceled', `<div class="container py-5"><div class="alert alert-warning"><h1 class="h4">Checkout canceled</h1><p>No credits were purchased.</p></div><a class="btn btn-primary" href="/credits">Choose a package</a></div>`));

billing.get('/packages', requireAuth, async (c) => c.json({ packages: await activeCreditPackages() }));

export const stripeWebhook = new Hono();
stripeWebhook.post('/stripe', async (c) => {
  const signature = c.req.header('stripe-signature');
  if (!signature) return c.json({ error: 'Missing Stripe signature' }, 400);
  const raw = await c.req.text();
  try {
    const event = getStripe().webhooks.constructEvent(raw, signature, requireStripeWebhookSecret());
    const result = await processStripeEvent(event);
    return c.json({ received: true, ...result });
  } catch (error) {
    return c.json({ error: error.message }, 400);
  }
});
