import { Hono } from 'hono';
import { z } from 'zod';
import { getCookie } from 'hono/cookie';
import { query } from '../db/postgres.js';
import { CSRF_COOKIE } from '../services/authService.js';
import { requireAuth } from '../middleware/auth.js';
import { ensureUserApiKey, rotateApiKey, normalizeDomain } from '../services/apiKeyService.js';

export const customer = new Hono();
customer.use('*', requireAuth);

async function formBody(c) { return c.req.header('content-type')?.includes('application/json') ? c.req.json() : c.req.parseBody(); }
function csrfOk(c, body) { return getCookie(c, CSRF_COOKIE) && getCookie(c, CSRF_COOKIE) === body.csrfToken; }
function redirectBack(c, path) { return c.redirect(path, 303); }

customer.post('/api-key/ensure', async (c) => {
  const body = await formBody(c);
  if (!csrfOk(c, body)) return c.json({ error: 'Invalid CSRF token' }, 403);
  const result = await ensureUserApiKey(c.get('user').id);
  return c.json(result.rawKey ? { apiKey: result.rawKey } : { message: 'An active API key already exists.' }, result.rawKey ? 201 : 200);
});

customer.post('/api-key/rotate', async (c) => {
  const body = await formBody(c);
  if (!csrfOk(c, body)) return c.json({ error: 'Invalid CSRF token' }, 403);
  const result = await rotateApiKey(c.get('user').id);
  if ((c.req.header('accept') || '').includes('text/html')) return c.html(`<div class="container py-5"><div class="alert alert-warning"><h1 class="h4">New API key</h1><p>Store this API key now. It will only be shown once.</p><code>${result.rawKey}</code></div><a href="/api-key">Back to API key page</a></div>`, 201);
  return c.json({ apiKey: result.rawKey, message: 'Store this API key now. It will only be shown once.' }, 201);
});

const domainSchema = z.string().trim().min(3).max(253);
customer.post('/domains', async (c) => {
  const body = await formBody(c);
  if (!csrfOk(c, body)) return c.json({ error: 'Invalid CSRF token' }, 403);
  const parsed = domainSchema.safeParse(body.domain);
  if (!parsed.success) return c.json({ error: 'Invalid domain' }, 400);
  await query('insert into allowed_domains (user_id, domain) values ($1, $2) on conflict (user_id, domain) do update set status = excluded.status', [c.get('user').id, normalizeDomain(parsed.data)]);
  return redirectBack(c, '/domains');
});

customer.post('/domains/:id', async (c) => {
  const body = await formBody(c);
  if (!csrfOk(c, body)) return c.json({ error: 'Invalid CSRF token' }, 403);
  const domain = normalizeDomain(domainSchema.parse(body.domain));
  await query('update allowed_domains set domain = $1, status = $2 where id = $3 and user_id = $4', [domain, body.status === 'disabled' ? 'disabled' : 'active', c.req.param('id'), c.get('user').id]);
  return redirectBack(c, '/domains');
});

customer.post('/domains/:id/delete', async (c) => {
  const body = await formBody(c);
  if (!csrfOk(c, body)) return c.json({ error: 'Invalid CSRF token' }, 403);
  await query('delete from allowed_domains where id = $1 and user_id = $2', [c.req.param('id'), c.get('user').id]);
  return redirectBack(c, '/domains');
});

customer.post('/domains/wildcard', async (c) => {
  const body = await formBody(c);
  if (!csrfOk(c, body)) return c.json({ error: 'Invalid CSRF token' }, 403);
  await query('update users set wildcard_domains_enabled = $1 where id = $2', [body.enabled === 'on' || body.enabled === 'true', c.get('user').id]);
  return redirectBack(c, '/domains');
});
