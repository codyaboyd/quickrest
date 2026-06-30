import { pool, query } from '../db/postgres.js';

export const CREDIT_TYPES = Object.freeze({
  PURCHASE: 'purchase',
  ENDPOINT_USAGE: 'endpoint_usage',
  REFUND: 'refund',
  ADMIN_ADJUSTMENT: 'admin_adjustment',
  FAILED_USAGE_REFUND: 'failed_usage_refund'
});

export async function ensureCreditBalance(userId, client = null) {
  const db = client || { query };
  const result = await db.query(
    `insert into credit_balances (user_id, currency, balance)
     values ($1, 'credits', 0)
     on conflict (user_id, currency) do update set user_id = excluded.user_id
     returning *`,
    [userId]
  );
  return result.rows[0];
}

export async function deductEndpointCredits({ userId, apiKeyId, endpoint, amount, requestId, success, failureReason }) {
  if (amount <= 0) return { charged: 0, balanceAfter: null, transaction: null };
  const client = await pool.connect();
  try {
    await client.query('begin');
    const balance = await ensureCreditBalance(userId, client);
    const updated = await client.query(
      `update credit_balances
          set balance = balance - $2, lifetime_used = lifetime_used + $2
        where id = $1 and balance >= $2
        returning id, balance`,
      [balance.id, amount]
    );
    if (updated.rowCount !== 1) throw new Error('Insufficient credits');
    const balanceAfter = updated.rows[0].balance;
    const tx = await client.query(
      `insert into credit_transactions (user_id, balance_id, api_key_id, endpoint_id, transaction_type, amount, balance_after, request_id, metadata, description)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
       returning *`,
      [userId, balance.id, apiKeyId, endpoint.id, CREDIT_TYPES.ENDPOINT_USAGE, -amount, balanceAfter, requestId, JSON.stringify({ publicPath: endpoint.public_path, success, failureReason }), `Endpoint usage: ${endpoint.public_path}`]
    );
    await client.query('commit');
    return { charged: amount, balanceAfter, transaction: tx.rows[0] };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally { client.release(); }
}

export async function adjustCredits({ userId, amount, type = CREDIT_TYPES.ADMIN_ADJUSTMENT, description, createdBy, metadata = {}, stripeReference, idempotencyKey }) {
  if (!Number.isInteger(amount) || amount === 0) throw new Error('Credit amount must be a non-zero integer');
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (idempotencyKey) {
      const existing = await client.query('select * from credit_transactions where idempotency_key = $1 limit 1', [idempotencyKey]);
      if (existing.rowCount) { await client.query('commit'); return { transaction: existing.rows[0], idempotent: true }; }
    }
    const balance = await ensureCreditBalance(userId, client);
    const updated = await client.query(
      `update credit_balances
          set balance = balance + $2,
              lifetime_purchased = lifetime_purchased + case when $3 = 'purchase' and $2 > 0 then $2 else 0 end
        where id = $1 and balance + $2 >= 0
        returning id, balance`,
      [balance.id, amount, type]
    );
    if (updated.rowCount !== 1) throw new Error('Credit adjustment would make the balance negative');
    const tx = await client.query(
      `insert into credit_transactions (user_id, balance_id, transaction_type, amount, balance_after, stripe_reference, idempotency_key, metadata, description, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
       returning *`,
      [userId, balance.id, type, amount, updated.rows[0].balance, stripeReference || null, idempotencyKey || null, JSON.stringify(metadata), description || null, createdBy || null]
    );
    await client.query('commit');
    return { transaction: tx.rows[0], idempotent: false };
  } catch (error) {
    await client.query('rollback');
    if (error.code === '23505' && idempotencyKey) return adjustCredits({ userId, amount, type, description, createdBy, metadata, stripeReference, idempotencyKey });
    throw error;
  } finally { client.release(); }
}

export async function recordStripePurchase({ userId, credits, stripeReference, idempotencyKey, metadata = {} }) {
  return adjustCredits({ userId, amount: credits, type: CREDIT_TYPES.PURCHASE, description: 'Stripe credit purchase', stripeReference, idempotencyKey: idempotencyKey || stripeReference, metadata });
}

export async function refundFailedUsage({ userId, amount, requestId, description = 'Failed usage refund', metadata = {} }) {
  return adjustCredits({ userId, amount, type: CREDIT_TYPES.FAILED_USAGE_REFUND, description, idempotencyKey: requestId ? `failed-usage-refund:${requestId}` : undefined, metadata: { ...metadata, requestId } });
}

export async function usageSummary({ userId, groupBy = 'day', limit = 100 } = {}) {
  const dimensions = {
    day: `date_trunc('day', t.created_at)`,
    endpoint: `coalesce(e.public_path, 'unknown')`,
    user: `u.email::text`
  };
  const expr = dimensions[groupBy] || dimensions.day;
  const params = [];
  const where = userId ? `where t.user_id = $1` : '';
  if (userId) params.push(userId);
  params.push(limit);
  return (await query(
    `select ${expr} as bucket, count(*)::int transactions, abs(coalesce(sum(t.amount),0))::int credits
       from credit_transactions t
       left join proxy_endpoints e on e.id = t.endpoint_id
       left join users u on u.id = t.user_id
       ${where} ${where ? 'and' : 'where'} t.transaction_type = 'endpoint_usage'
      group by bucket order by credits desc limit $${params.length}`,
    params
  )).rows;
}
