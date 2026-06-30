import { Hono } from 'hono';
import { z } from 'zod';
import { getCookie } from 'hono/cookie';
import { html } from 'hono/html';
import { query } from '../db/postgres.js';
import { requireAdmin } from '../middleware/auth.js';
import { CSRF_COOKIE } from '../services/authService.js';
import { layout } from '../templates/layout.js';

export const admin = new Hono();
admin.use('*', requireAdmin);

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const pathSchema = z.string().trim().min(2).max(240).regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/, 'Use a URL path beginning with /.');
const boolFromForm = z.preprocess((value) => value === 'true' || value === 'on' || value === true, z.boolean());
const endpointSchema = z.object({
  publicPath: pathSchema,
  targetUrl: z.string().trim().url().max(2048).refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'Target URL must be HTTP or HTTPS.'),
  httpMethod: z.enum(METHODS),
  isEnabled: boolFromForm.default(false),
  creditCost: z.coerce.number().int().min(0).max(100000),
  timeoutMs: z.coerce.number().int().min(100).max(300000),
  forwardHeaders: z.string().optional().default(''),
  customHeaders: z.string().optional().default(''),
  description: z.string().trim().max(2000).optional().default(''),
  adminNotes: z.string().trim().max(4000).optional().default(''),
  deductCreditsOnFailure: boolFromForm.default(false)
});
const testSchema = z.object({
  requestPath: pathSchema,
  method: z.enum(METHODS),
  body: z.string().max(20000).optional().default(''),
  headers: z.string().max(10000).optional().default('')
});

function escapeHtml(value = '') { return String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }
function render(c, title, children) { return c.html(html`${layout({ title, children, user: c.get('user') })}`); }
async function body(c) { return c.req.header('content-type')?.includes('application/json') ? c.req.json() : c.req.parseBody(); }
function wantsJson(c) { return (c.req.header('accept') || '').includes('application/json') || c.req.header('content-type')?.includes('application/json'); }
function csrfOk(c, data) { const token = getCookie(c, CSRF_COOKIE); return token && token === data.csrfToken; }
function parseHeaderNames(raw) { return raw.split(/[\n,]/).map((h) => h.trim().toLowerCase()).filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i); }
function parseCustomHeaders(raw) {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Custom headers must be a JSON object.');
    return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [String(k).trim(), String(v)]).filter(([k]) => k));
  } catch (error) { throw new Error(error.message || 'Custom headers must be valid JSON.'); }
}
function parseRequestHeaders(raw) { return parseCustomHeaders(raw); }
function headersConfig(data) { return { forwardHeaders: parseHeaderNames(data.forwardHeaders), customHeaders: parseCustomHeaders(data.customHeaders) }; }
function csrf(c) { return getCookie(c, CSRF_COOKIE) || ''; }
function adminNav() { return `<div class="list-group mb-4"><a class="list-group-item" href="/admin">Admin dashboard</a><a class="list-group-item" href="/admin/endpoints">Endpoint list</a><a class="list-group-item" href="/admin/endpoints/new">Create endpoint</a><a class="list-group-item" href="/admin/test">Test proxy endpoint</a></div>`; }
function errorBlock(errors) { return errors?.length ? `<div class="alert alert-danger"><strong>Fix these issues:</strong><ul class="mb-0">${errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul></div>` : ''; }
function endpointForm(c, action, endpoint = {}, errors = []) {
  const config = endpoint.headers_config || {};
  const custom = JSON.stringify(config.customHeaders || {}, null, 2);
  const forwards = (config.forwardHeaders || []).join('\n');
  return `<div class="container py-5"><h1 class="fw-bold">${endpoint.id ? 'Edit endpoint' : 'Create endpoint'}</h1>${adminNav()}${errorBlock(errors)}<form class="needs-validation" method="post" action="${action}" novalidate><input type="hidden" name="csrfToken" value="${csrf(c)}"><div class="row g-3"><div class="col-md-6"><label class="form-label">Public proxy path</label><input class="form-control" name="publicPath" value="${escapeHtml(endpoint.public_path || '/api/proxy/new')}" required></div><div class="col-md-3"><label class="form-label">HTTP method</label><select class="form-select" name="httpMethod">${METHODS.map(m => `<option ${m === (endpoint.http_method || 'GET') ? 'selected' : ''}>${m}</option>`).join('')}</select></div><div class="col-md-3"><label class="form-label">Enabled</label><select class="form-select" name="isEnabled"><option value="true" ${endpoint.is_enabled !== false ? 'selected' : ''}>Enabled</option><option value="false" ${endpoint.is_enabled === false ? 'selected' : ''}>Disabled</option></select></div><div class="col-12"><label class="form-label">Target URL</label><input class="form-control" name="targetUrl" type="url" value="${escapeHtml(endpoint.target_url || 'https://httpbin.org/anything')}" required></div><div class="col-md-4"><label class="form-label">Credit cost</label><input class="form-control" name="creditCost" type="number" min="0" value="${endpoint.credit_cost ?? 1}" required></div><div class="col-md-4"><label class="form-label">Timeout (ms)</label><input class="form-control" name="timeoutMs" type="number" min="100" max="300000" value="${endpoint.timeout_ms ?? 30000}" required></div><div class="col-md-4"><label class="form-label">Charge failed upstream calls</label><select class="form-select" name="deductCreditsOnFailure"><option value="false" ${!endpoint.deduct_credits_on_failure ? 'selected' : ''}>No</option><option value="true" ${endpoint.deduct_credits_on_failure ? 'selected' : ''}>Yes</option></select></div><div class="col-md-6"><label class="form-label">Headers to forward</label><textarea class="form-control" name="forwardHeaders" rows="5" placeholder="accept&#10;content-type">${escapeHtml(forwards)}</textarea></div><div class="col-md-6"><label class="form-label">Custom target headers (JSON)</label><textarea class="form-control font-monospace" name="customHeaders" rows="5">${escapeHtml(custom)}</textarea></div><div class="col-md-6"><label class="form-label">Description</label><textarea class="form-control" name="description" rows="4">${escapeHtml(endpoint.description || '')}</textarea></div><div class="col-md-6"><label class="form-label">Internal notes</label><textarea class="form-control" name="adminNotes" rows="4">${escapeHtml(endpoint.admin_notes || '')}</textarea></div></div><button class="btn btn-primary mt-4">Save endpoint</button></form></div>`;
}
async function endpointStats(id) { return (await query(`select count(*)::int calls, coalesce(sum(credits_charged),0)::int credits, coalesce(avg(duration_ms),0)::int avg_ms from api_usage_logs where endpoint_id = $1`, [id])).rows[0]; }
async function recentUsage(id) { return (await query(`select created_at, request_method, request_path, response_status, credits_charged, auth_success, failure_reason, duration_ms from api_usage_logs where endpoint_id = $1 order by created_at desc limit 25`, [id])).rows; }
async function findEndpoint(id) { return (await query('select * from proxy_endpoints where id = $1', [id])).rows[0]; }

admin.get('/', async (c) => {
  const stats = await query(`select count(*)::int total, count(*) filter (where is_enabled)::int enabled, coalesce(sum(credit_cost),0)::int configured_credits from proxy_endpoints`);
  const usage = await query(`select coalesce(sum(credits_charged),0)::int credits, count(*)::int calls from api_usage_logs where endpoint_id is not null`);
  const s = stats.rows[0], u = usage.rows[0];
  return render(c, 'Admin dashboard', `<div class="container py-5"><h1 class="fw-bold mb-4">Admin dashboard</h1>${adminNav()}<div class="row g-4"><div class="col-md-3"><div class="card metric-card"><div class="card-body"><span class="text-muted">Endpoints</span><h2>${s.total}</h2></div></div></div><div class="col-md-3"><div class="card metric-card"><div class="card-body"><span class="text-muted">Enabled</span><h2>${s.enabled}</h2></div></div></div><div class="col-md-3"><div class="card metric-card"><div class="card-body"><span class="text-muted">Proxy calls</span><h2>${u.calls}</h2></div></div></div><div class="col-md-3"><div class="card metric-card"><div class="card-body"><span class="text-muted">Credits used</span><h2>${u.credits}</h2></div></div></div></div></div>`);
});

admin.get('/endpoints', async (c) => {
  const endpoints = await query(`select e.*, coalesce(u.calls,0)::int calls, coalesce(u.credits,0)::int credits from proxy_endpoints e left join (select endpoint_id, count(*) calls, sum(credits_charged) credits from api_usage_logs group by endpoint_id) u on u.endpoint_id = e.id order by e.created_at desc`);
  const rows = endpoints.rows.map(e => `<tr><td><a href="/admin/endpoints/${e.id}"><code>${escapeHtml(e.public_path)}</code></a></td><td>${e.http_method}</td><td>${escapeHtml(e.target_url)}</td><td>${e.is_enabled ? 'Enabled' : 'Disabled'}</td><td>${e.credit_cost}</td><td>${e.calls}</td><td>${e.credits}</td><td><a class="btn btn-sm btn-outline-primary" href="/admin/endpoints/${e.id}/edit">Edit</a></td></tr>`).join('');
  return render(c, 'Endpoint list', `<div class="container py-5"><div class="d-flex justify-content-between"><h1 class="fw-bold">Endpoint list</h1><a class="btn btn-primary" href="/admin/endpoints/new">Create endpoint</a></div>${adminNav()}<div class="table-responsive"><table class="table align-middle"><thead><tr><th>Path</th><th>Method</th><th>Target</th><th>Status</th><th>Cost</th><th>Calls</th><th>Credits</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`);
});
admin.get('/endpoints/new', (c) => render(c, 'Create endpoint', endpointForm(c, '/admin/endpoints')));
admin.get('/endpoints/:id/edit', async (c) => render(c, 'Edit endpoint', endpointForm(c, `/admin/endpoints/${c.req.param('id')}`, await findEndpoint(c.req.param('id')))));
admin.get('/endpoints/:id', async (c) => {
  const e = await findEndpoint(c.req.param('id')); if (!e) return c.json({ error: 'Endpoint not found' }, 404);
  const [stats, logs] = await Promise.all([endpointStats(e.id), recentUsage(e.id)]);
  const usageRows = logs.map(l => `<tr><td>${l.created_at}</td><td>${l.request_method} ${escapeHtml(l.request_path)}</td><td>${l.response_status ?? ''}</td><td>${l.credits_charged}</td><td>${l.duration_ms ?? ''}</td><td>${l.auth_success ? 'OK' : escapeHtml(l.failure_reason || 'Failed')}</td></tr>`).join('');
  return render(c, 'Endpoint detail', `<div class="container py-5"><h1 class="fw-bold"><code>${escapeHtml(e.public_path)}</code></h1>${adminNav()}<div class="mb-3 d-flex gap-2"><a class="btn btn-primary" href="/admin/endpoints/${e.id}/edit">Edit</a><form method="post" action="/admin/endpoints/${e.id}/toggle"><input type="hidden" name="csrfToken" value="${csrf(c)}"><button class="btn btn-warning">${e.is_enabled ? 'Disable' : 'Enable'}</button></form><form method="post" action="/admin/endpoints/${e.id}/delete" onsubmit="return confirm('Delete this endpoint?')"><input type="hidden" name="csrfToken" value="${csrf(c)}"><button class="btn btn-outline-danger">Delete</button></form></div><div class="row g-4 mb-4"><div class="col-md-4"><div class="card"><div class="card-body"><span class="text-muted">Calls</span><h2>${stats.calls}</h2></div></div></div><div class="col-md-4"><div class="card"><div class="card-body"><span class="text-muted">Credits/revenue</span><h2>${stats.credits}</h2></div></div></div><div class="col-md-4"><div class="card"><div class="card-body"><span class="text-muted">Avg ms</span><h2>${Math.round(stats.avg_ms)}</h2></div></div></div></div><dl class="row"><dt class="col-sm-3">Target URL</dt><dd class="col-sm-9">${escapeHtml(e.target_url)}</dd><dt class="col-sm-3">Method</dt><dd class="col-sm-9">${e.http_method}</dd><dt class="col-sm-3">Timeout</dt><dd class="col-sm-9">${e.timeout_ms} ms</dd><dt class="col-sm-3">Description</dt><dd class="col-sm-9">${escapeHtml(e.description || '')}</dd><dt class="col-sm-3">Internal notes</dt><dd class="col-sm-9">${escapeHtml(e.admin_notes || '')}</dd></dl><h2 class="h4">Recent usage</h2><table class="table"><thead><tr><th>Date</th><th>Request</th><th>Status</th><th>Credits</th><th>ms</th><th>Auth</th></tr></thead><tbody>${usageRows}</tbody></table></div>`);
});

async function saveEndpoint(c, id) {
  const data = await body(c); if (!c.req.path.startsWith('/admin/api') && !csrfOk(c, data)) return c.json({ error: 'Invalid CSRF token' }, 403);
  const parsed = endpointSchema.safeParse(data);
  if (!parsed.success) {
    const errors = parsed.error.issues.map(i => i.message);
    if (wantsJson(c)) return c.json({ errors }, 400);
    return render(c, id ? 'Edit endpoint' : 'Create endpoint', endpointForm(c, id ? `/admin/endpoints/${id}` : '/admin/endpoints', {}, errors));
  }
  let config; try { config = headersConfig(parsed.data); } catch (error) { return c.json({ errors: [error.message] }, 400); }
  const values = [parsed.data.publicPath, parsed.data.targetUrl, parsed.data.httpMethod, parsed.data.isEnabled, config, parsed.data.timeoutMs, parsed.data.creditCost, parsed.data.description, parsed.data.adminNotes, parsed.data.deductCreditsOnFailure, c.get('user').id];
  const sql = id ? `update proxy_endpoints set public_path=$1,target_url=$2,http_method=$3,is_enabled=$4,headers_config=$5,timeout_ms=$6,credit_cost=$7,description=$8,admin_notes=$9,deduct_credits_on_failure=$10,updated_by=$11 where id=$12 returning *` : `insert into proxy_endpoints (public_path,target_url,http_method,is_enabled,headers_config,timeout_ms,credit_cost,description,admin_notes,deduct_credits_on_failure,created_by,updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) returning *`;
  try { const saved = await query(sql, id ? [...values, id] : values); return wantsJson(c) ? c.json({ endpoint: saved.rows[0] }, id ? 200 : 201) : c.redirect(`/admin/endpoints/${saved.rows[0].id}`, 303); }
  catch (error) { return c.json({ errors: [error.code === '23505' ? 'An endpoint with this path and method already exists.' : error.message] }, 400); }
}
admin.post('/endpoints', (c) => saveEndpoint(c));
admin.post('/endpoints/:id', (c) => saveEndpoint(c, c.req.param('id')));
admin.post('/endpoints/:id/toggle', async (c) => { const data = await body(c); if (!csrfOk(c, data)) return c.json({ error: 'Invalid CSRF token' }, 403); await query('update proxy_endpoints set is_enabled = not is_enabled, updated_by = $2 where id = $1', [c.req.param('id'), c.get('user').id]); return c.redirect(`/admin/endpoints/${c.req.param('id')}`, 303); });
admin.post('/endpoints/:id/delete', async (c) => { const data = await body(c); if (!csrfOk(c, data)) return c.json({ error: 'Invalid CSRF token' }, 403); await query('delete from proxy_endpoints where id = $1', [c.req.param('id')]); return c.redirect('/admin/endpoints', 303); });
admin.get('/test', (c) => render(c, 'Test proxy endpoint', `<div class="container py-5"><h1 class="fw-bold">Test proxy endpoint</h1>${adminNav()}<form method="post" action="/admin/test"><input type="hidden" name="csrfToken" value="${csrf(c)}"><div class="row g-3"><div class="col-md-8"><label class="form-label">Proxy path</label><input class="form-control" name="requestPath" value="/api/proxy/new"></div><div class="col-md-4"><label class="form-label">Method</label><select class="form-select" name="method">${METHODS.map(m => `<option>${m}</option>`).join('')}</select></div><div class="col-md-6"><label class="form-label">Headers JSON</label><textarea class="form-control font-monospace" name="headers" rows="5">{}</textarea></div><div class="col-md-6"><label class="form-label">Body</label><textarea class="form-control font-monospace" name="body" rows="5"></textarea></div></div><button class="btn btn-primary mt-3">Run test</button></form></div>`));
admin.post('/test', async (c) => {
  const data = await body(c); if (!csrfOk(c, data)) return c.json({ error: 'Invalid CSRF token' }, 403);
  const parsed = testSchema.safeParse(data); if (!parsed.success) return c.json({ errors: parsed.error.issues.map(i => i.message) }, 400);
  let extraHeaders; try { extraHeaders = parseRequestHeaders(parsed.data.headers); } catch (error) { return c.json({ errors: [error.message] }, 400); }
  const started = performance.now(); const url = new URL(parsed.data.requestPath, new URL(c.req.url).origin);
  const response = await fetch(url, { method: parsed.data.method, headers: extraHeaders, body: ['GET', 'HEAD'].includes(parsed.data.method) ? undefined : parsed.data.body });
  const text = await response.text();
  return c.json({ status: response.status, durationMs: Math.round(performance.now() - started), headers: Object.fromEntries(response.headers.entries()), body: text.slice(0, 20000) });
});
admin.get('/api/endpoints', async (c) => c.json({ endpoints: (await query('select * from proxy_endpoints order by created_at desc')).rows }));
admin.post('/api/endpoints', (c) => saveEndpoint(c));
admin.post('/api/endpoints/:id', (c) => saveEndpoint(c, c.req.param('id')));
admin.post('/api/endpoints/:id/toggle', async (c) => { await query('update proxy_endpoints set is_enabled = not is_enabled, updated_by = $2 where id = $1 returning *', [c.req.param('id'), c.get('user').id]); return c.json({ ok: true }); });
admin.delete('/api/endpoints/:id', async (c) => { await query('delete from proxy_endpoints where id = $1', [c.req.param('id')]); return c.json({ ok: true }); });
admin.post('/api/test', async (c) => {
  const data = await body(c);
  const parsed = testSchema.safeParse(data); if (!parsed.success) return c.json({ errors: parsed.error.issues.map(i => i.message) }, 400);
  let extraHeaders; try { extraHeaders = parseRequestHeaders(parsed.data.headers); } catch (error) { return c.json({ errors: [error.message] }, 400); }
  const started = performance.now(); const url = new URL(parsed.data.requestPath, new URL(c.req.url).origin);
  const response = await fetch(url, { method: parsed.data.method, headers: extraHeaders, body: ['GET', 'HEAD'].includes(parsed.data.method) ? undefined : parsed.data.body });
  const text = await response.text();
  return c.json({ status: response.status, durationMs: Math.round(performance.now() - started), headers: Object.fromEntries(response.headers.entries()), body: text.slice(0, 20000) });
});
