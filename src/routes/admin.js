import { Hono } from 'hono';
import { z } from 'zod';
import { getCookie } from 'hono/cookie';
import { html } from 'hono/html';
import { query } from '../db/postgres.js';
import { requireAdmin } from '../middleware/auth.js';
import { CSRF_COOKIE, hashSecret } from '../services/authService.js';
import { layout } from '../templates/layout.js';
import { adjustCredits, usageSummary } from '../services/creditService.js';
import { rotateApiKey } from '../services/apiKeyService.js';
import { definitionMap, getAdminSettings, updateSetting } from '../services/adminSettingsService.js';
import { env } from '../config/env.js';

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
async function auditAdminChange(c, action, entityType, entityId = null, metadata = {}) {
  await query(`insert into audit_logs (actor_user_id, action, entity_type, entity_id, ip_address, user_agent, metadata) values ($1,$2,$3,$4,nullif($5, '')::inet,$6,$7::jsonb)`, [c.get('user')?.id || null, action, entityType, entityId, c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || '', c.req.header('user-agent') || '', JSON.stringify(metadata)]);
}
function adminNav() { return `<div class="list-group mb-4"><a class="list-group-item" href="/admin">Admin dashboard</a><a class="list-group-item" href="/admin/users">User management</a><a class="list-group-item" href="/admin/settings">Platform settings</a><a class="list-group-item" href="/admin/audit">Audit log</a><a class="list-group-item" href="/admin/security">API protection</a><a class="list-group-item" href="/admin/endpoints">Endpoint list</a><a class="list-group-item" href="/admin/endpoints/new">Create endpoint</a><a class="list-group-item" href="/admin/credits">Credits & transactions</a><a class="list-group-item" href="/admin/billing">Billing packages & revenue</a><a class="list-group-item" href="/admin/test">Test proxy endpoint</a></div>`; }
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
  const [metrics, topEndpoints, topUsers, failed, webhookHealth, recentAdminActions] = await Promise.all([
    query(`select
             (select count(*)::int from users) total_users,
             (select count(*)::int from users where status = 'active') active_users,
             (select coalesce(sum(amount_total_cents),0)::int from stripe_checkout_sessions where payment_status = 'paid') revenue_cents,
             (select coalesce(sum(credits),0)::int from stripe_checkout_sessions where payment_status = 'paid') credits_sold,
             (select coalesce(sum(credits_charged),0)::int from api_usage_logs) credits_consumed,
             (select count(*)::int from api_usage_logs where created_at >= now() - interval '24 hours') requests_24h`),
    query(`select coalesce(e.public_path, l.service_slug, l.request_path) endpoint, count(*)::int calls, coalesce(sum(l.credits_charged),0)::int credits, coalesce(avg(l.duration_ms),0)::int avg_ms
             from api_usage_logs l left join proxy_endpoints e on e.id = l.endpoint_id
            group by 1 order by calls desc limit 10`),
    query(`select u.email, u.username, count(l.*)::int calls, coalesce(sum(l.credits_charged),0)::int credits
             from api_usage_logs l join users u on u.id = l.user_id
            group by u.id order by credits desc, calls desc limit 10`),
    query(`select l.created_at, u.email, coalesce(e.public_path, l.service_slug, l.request_path) endpoint, l.request_method, l.request_path, l.response_status, l.failure_reason, l.request_ip, l.request_domain
             from api_usage_logs l left join users u on u.id = l.user_id left join proxy_endpoints e on e.id = l.endpoint_id
            where l.auth_success = false or coalesce(l.response_status, 0) >= 400 order by l.created_at desc limit 25`),
    query(`select processing_status, count(*)::int count from stripe_webhook_events where created_at >= now() - interval '7 days' group by processing_status`),
    query(`select a.created_at, u.email, a.action, a.entity_type from audit_logs a left join users u on u.id = a.actor_user_id where a.action like 'admin_%' order by a.created_at desc limit 15`)
  ]);
  const m = metrics.rows[0];
  const endpointRows = topEndpoints.rows.map(r => `<tr><td>${escapeHtml(r.endpoint || '')}</td><td>${r.calls}</td><td>${r.credits}</td><td>${Math.round(r.avg_ms)}</td></tr>`).join('') || '<tr><td colspan="4" class="text-muted">No proxy usage yet.</td></tr>';
  const userRows = topUsers.rows.map(r => `<tr><td>${escapeHtml(r.email || r.username || '')}</td><td>${r.calls}</td><td>${r.credits}</td></tr>`).join('') || '<tr><td colspan="3" class="text-muted">No user usage yet.</td></tr>';
  const failedRows = failed.rows.map(r => `<tr><td>${r.created_at}</td><td>${escapeHtml(r.email || '')}</td><td>${escapeHtml(r.endpoint || '')}</td><td>${r.response_status ?? ''}</td><td>${escapeHtml(r.failure_reason || 'HTTP failure')}</td><td>${escapeHtml(r.request_ip || '')}</td></tr>`).join('') || '<tr><td colspan="6" class="text-muted">No failed proxy requests.</td></tr>';
  const webhookRows = webhookHealth.rows.map(r => `<tr><td>${escapeHtml(r.processing_status)}</td><td>${r.count}</td></tr>`).join('') || '<tr><td colspan="2" class="text-muted">No webhook events in the last 7 days.</td></tr>';
  const actionRows = recentAdminActions.rows.map(r => `<tr><td>${r.created_at}</td><td>${escapeHtml(r.email || 'system')}</td><td>${escapeHtml(r.action)}</td><td>${escapeHtml(r.entity_type)}</td></tr>`).join('') || '<tr><td colspan="4" class="text-muted">No recent admin actions.</td></tr>';
  return render(c, 'Admin dashboard', `<div class="container py-5"><h1 class="fw-bold mb-4">Admin dashboard</h1>${adminNav()}<div class="row g-4 mb-4"><div class="col-md-3"><div class="card metric-card"><div class="card-body"><span class="text-muted">Total users</span><h2>${m.total_users}</h2></div></div></div><div class="col-md-3"><div class="card metric-card"><div class="card-body"><span class="text-muted">Active users</span><h2>${m.active_users}</h2></div></div></div><div class="col-md-3"><div class="card metric-card"><div class="card-body"><span class="text-muted">Total revenue</span><h2>$${(m.revenue_cents / 100).toFixed(2)}</h2></div></div></div><div class="col-md-3"><div class="card metric-card"><div class="card-body"><span class="text-muted">Requests (24h)</span><h2>${m.requests_24h}</h2></div></div></div><div class="col-md-6"><div class="card metric-card"><div class="card-body"><span class="text-muted">Credits sold</span><h2>${m.credits_sold}</h2></div></div></div><div class="col-md-6"><div class="card metric-card"><div class="card-body"><span class="text-muted">Credits consumed</span><h2>${m.credits_consumed}</h2></div></div></div></div><div class="row g-4"><div class="col-lg-6"><div class="card h-100"><div class="card-body"><h2 class="h5">Top endpoints</h2><table class="table table-sm"><thead><tr><th>Endpoint</th><th>Calls</th><th>Credits</th><th>Avg ms</th></tr></thead><tbody>${endpointRows}</tbody></table></div></div></div><div class="col-lg-6"><div class="card h-100"><div class="card-body"><h2 class="h5">Top users</h2><table class="table table-sm"><thead><tr><th>User</th><th>Calls</th><th>Credits</th></tr></thead><tbody>${userRows}</tbody></table></div></div></div><div class="col-lg-8"><div class="card h-100"><div class="card-body"><h2 class="h5">Failed proxy requests</h2><div class="table-responsive"><table class="table table-sm"><thead><tr><th>Date</th><th>User</th><th>Endpoint</th><th>Status</th><th>Reason</th><th>IP</th></tr></thead><tbody>${failedRows}</tbody></table></div></div></div></div><div class="col-lg-4"><div class="card mb-4"><div class="card-body"><h2 class="h5">Stripe webhook health</h2><table class="table table-sm"><thead><tr><th>Status</th><th>7d events</th></tr></thead><tbody>${webhookRows}</tbody></table></div></div><div class="card"><div class="card-body"><h2 class="h5">Recent admin actions</h2><table class="table table-sm"><thead><tr><th>Date</th><th>Admin</th><th>Action</th><th>Entity</th></tr></thead><tbody>${actionRows}</tbody></table></div></div></div></div></div>`);
});



function parseSettingValue(definition, raw) {
  if (definition.type === 'boolean') return raw === 'on' || raw === 'true' || raw === true;
  if (definition.type === 'number') return z.coerce.number().int().min(0).max(100000000).parse(raw);
  if (definition.type === 'url') return z.string().trim().url().max(2048).parse(raw);
  if (definition.type === 'select') return z.enum(definition.options).parse(raw);
  if (definition.type === 'json') {
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON settings must be objects.');
    return parsed;
  }
  return z.string().trim().max(4000).parse(raw || '');
}
function settingInput(setting) {
  const value = setting.type === 'json' ? JSON.stringify(setting.value, null, 2) : String(setting.value ?? '');
  if (setting.type === 'boolean') return `<div class="form-check form-switch"><input class="form-check-input" type="checkbox" name="value" ${setting.value ? 'checked' : ''}><label class="form-check-label">Enabled</label></div>`;
  if (setting.type === 'textarea' || setting.type === 'json') return `<textarea class="form-control ${setting.type === 'json' ? 'font-monospace' : ''}" name="value" rows="${setting.type === 'json' ? 6 : 3}">${escapeHtml(value)}</textarea>`;
  if (setting.type === 'select') return `<select class="form-select" name="value">${setting.options.map((option) => `<option value="${option}" ${option === setting.value ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}</select>`;
  return `<input class="form-control" name="value" type="${setting.type === 'number' ? 'number' : 'text'}" value="${escapeHtml(value)}">`;
}

admin.get('/settings', async (c) => {
  const settings = await getAdminSettings();
  const rows = settings.map((setting) => `<div class="card mb-3"><div class="card-body"><form method="post" action="/admin/settings/${encodeURIComponent(setting.key)}"><input type="hidden" name="csrfToken" value="${csrf(c)}"><div class="row g-3 align-items-start"><div class="col-lg-4"><h2 class="h6 mb-1">${escapeHtml(setting.label)}</h2><code>${escapeHtml(setting.key)}</code><p class="text-muted small mb-0">${escapeHtml(setting.description || '')}</p></div><div class="col-lg-6">${settingInput(setting)}</div><div class="col-lg-2"><button class="btn btn-primary w-100">Save</button></div></div></form></div></div>`).join('');
  return render(c, 'Platform settings', `<div class="container py-5"><h1 class="fw-bold">Platform settings</h1>${adminNav()}<div class="alert alert-info">Stripe secret status is derived from environment config: <strong>${env.STRIPE_SECRET_KEY ? 'configured' : 'missing'}</strong>. Secret values are not displayed.</div>${rows}</div>`);
});

admin.post('/settings/:key', async (c) => {
  const data = await body(c); if (!csrfOk(c, data)) return c.json({ error: 'Invalid CSRF token' }, 403);
  const key = decodeURIComponent(c.req.param('key'));
  const definition = definitionMap().get(key);
  if (!definition) return c.json({ error: 'Unknown setting' }, 404);
  try { await updateSetting({ key, value: parseSettingValue(definition, data.value), updatedBy: c.get('user').id, c }); }
  catch (error) { return c.json({ errors: [error.message] }, 400); }
  return c.redirect('/admin/settings', 303);
});


admin.get('/security', async (c) => {
  const [suspicious, rules] = await Promise.all([
    query(`select s.created_at, u.email, s.ip_address, s.request_path, s.reason, s.severity, s.metadata from suspicious_usage_logs s left join users u on u.id = s.user_id order by s.created_at desc limit 100`),
    query(`select * from api_ip_access_rules order by created_at desc`)
  ]);
  const suspiciousRows = suspicious.rows.map((r) => `<tr><td>${r.created_at}</td><td>${escapeHtml(r.email || '')}</td><td>${escapeHtml(r.ip_address || '')}</td><td>${escapeHtml(r.request_path)}</td><td><code>${escapeHtml(r.reason)}</code></td><td>${escapeHtml(r.severity)}</td><td><pre class="mb-0 small">${escapeHtml(JSON.stringify(r.metadata, null, 2))}</pre></td></tr>`).join('');
  const ruleRows = rules.rows.map((r) => `<tr><td>${escapeHtml(r.list_type)}</td><td><code>${escapeHtml(r.ip_address || r.cidr || '')}</code></td><td>${r.is_enabled ? 'Enabled' : 'Disabled'}</td><td>${escapeHtml(r.reason || '')}</td><td><form method="post" action="/admin/security/ip-rules/${r.id}/delete"><input type="hidden" name="csrfToken" value="${csrf(c)}"><button class="btn btn-sm btn-outline-danger">Delete</button></form></td></tr>`).join('');
  return render(c, 'API protection', `<div class="container py-5"><h1 class="fw-bold">API protection</h1>${adminNav()}<div class="alert alert-info">Configure limits in <a href="/admin/settings">Platform settings</a>: global, per-user, per-endpoint, failed auth, login, and signup throttles.</div><div class="card mb-4"><div class="card-body"><h2 class="h5">IP allowlist/blocklist</h2><form class="row g-2" method="post" action="/admin/security/ip-rules"><input type="hidden" name="csrfToken" value="${csrf(c)}"><div class="col-md-2"><select class="form-select" name="listType"><option value="block">Block</option><option value="allow">Allow</option></select></div><div class="col-md-3"><input class="form-control" name="address" placeholder="IP or CIDR"></div><div class="col-md-5"><input class="form-control" name="reason" placeholder="Reason"></div><div class="col-md-2"><button class="btn btn-primary w-100">Add rule</button></div></form><table class="table table-sm mt-3"><thead><tr><th>Type</th><th>Address</th><th>Status</th><th>Reason</th><th></th></tr></thead><tbody>${ruleRows}</tbody></table></div></div><h2 class="h5">Suspicious usage</h2><div class="table-responsive"><table class="table table-sm"><thead><tr><th>Date</th><th>User</th><th>IP</th><th>Path</th><th>Reason</th><th>Severity</th><th>Metadata</th></tr></thead><tbody>${suspiciousRows}</tbody></table></div></div>`);
});

admin.post('/security/ip-rules', async (c) => {
  const data = await body(c); if (!csrfOk(c, data)) return c.json({ error: 'Invalid CSRF token' }, 403);
  const parsed = z.object({ listType: z.enum(['allow', 'block']), address: z.string().trim().min(1).max(64), reason: z.string().trim().max(500).optional().default('') }).safeParse(data);
  if (!parsed.success) return c.json({ errors: parsed.error.issues.map(i => i.message) }, 400);
  const isCidr = parsed.data.address.includes('/');
  await query(`insert into api_ip_access_rules (list_type, ip_address, cidr, reason, created_by) values ($1, ${isCidr ? 'null' : '$2::inet'}, ${isCidr ? '$2::cidr' : 'null'}, $3, $4)`, [parsed.data.listType, parsed.data.address, parsed.data.reason, c.get('user').id]);
  await auditAdminChange(c, 'admin_ip_access_rule_created', 'api_ip_access_rule', null, parsed.data);
  return c.redirect('/admin/security', 303);
});

admin.post('/security/ip-rules/:id/delete', async (c) => {
  const data = await body(c); if (!csrfOk(c, data)) return c.json({ error: 'Invalid CSRF token' }, 403);
  await query('delete from api_ip_access_rules where id = $1', [c.req.param('id')]);
  await auditAdminChange(c, 'admin_ip_access_rule_deleted', 'api_ip_access_rule', c.req.param('id'));
  return c.redirect('/admin/security', 303);
});

admin.get('/audit', async (c) => {
  const logs = (await query(`select a.created_at, u.email, a.action, a.entity_type, a.metadata from audit_logs a left join users u on u.id = a.actor_user_id order by a.created_at desc limit 200`)).rows;
  const rows = logs.map((log) => `<tr><td>${log.created_at}</td><td>${escapeHtml(log.email || 'system')}</td><td>${escapeHtml(log.action)}</td><td>${escapeHtml(log.entity_type)}</td><td><pre class="mb-0 small">${escapeHtml(JSON.stringify(log.metadata, null, 2))}</pre></td></tr>`).join('');
  return render(c, 'Audit log', `<div class="container py-5"><h1 class="fw-bold">Audit log</h1>${adminNav()}<div class="table-responsive"><table class="table align-middle"><thead><tr><th>Date</th><th>Actor</th><th>Action</th><th>Entity</th><th>Metadata</th></tr></thead><tbody>${rows}</tbody></table></div></div>`);
});


const passwordResetSchema = z.object({ password: z.string().min(8).max(256) });
const pinResetSchema = z.object({ recoveryPin: z.string().trim().regex(/^\d{4,12}$/, 'Use a 4-12 digit recovery PIN') });
const userCreditAdjustSchema = z.object({ amount: z.coerce.number().int().min(-1000000).max(1000000).refine(v => v !== 0), description: z.string().trim().max(1000).optional().default('Admin user credit adjustment') });
const deleteUserSchema = z.object({ confirmation: z.string().trim().min(1) });

async function findUser(id) { return (await query(`select u.id, u.username, u.email, u.role, u.status, u.wildcard_domains_enabled, u.created_at, u.updated_at, coalesce(b.balance,0)::int balance, coalesce(b.lifetime_purchased,0)::int lifetime_purchased, coalesce(b.lifetime_used,0)::int lifetime_used from users u left join credit_balances b on b.user_id = u.id and b.currency = 'credits' where u.id = $1`, [id])).rows[0]; }
async function activeAdminCount(excludeUserId = null) {
  const params = excludeUserId ? [excludeUserId] : [];
  return Number((await query(`select count(*)::int count from users where role = 'admin' and status = 'active' ${excludeUserId ? 'and id <> $1' : ''}`, params)).rows[0].count);
}
async function auditUserAction(c, action, targetUserId, metadata = {}) { await auditAdminChange(c, action, 'user', targetUserId, { targetUserId, ...metadata }); }
function userActions(c, user) {
  const disabledSelf = user.id === c.get('user').id;
  return `<div class="card mb-4"><div class="card-body"><h2 class="h5">Admin actions</h2><div class="d-flex flex-wrap gap-2 mb-3"><form method="post" action="/admin/users/${user.id}/status"><input type="hidden" name="csrfToken" value="${csrf(c)}"><button class="btn btn-warning" ${disabledSelf ? 'disabled title="You cannot suspend yourself"' : ''}>${user.status === 'active' ? 'Suspend user' : 'Reactivate user'}</button></form><form method="post" action="/admin/users/${user.id}/role"><input type="hidden" name="csrfToken" value="${csrf(c)}"><button class="btn btn-outline-primary" ${disabledSelf ? 'disabled title="You cannot change your own role"' : ''}>${user.role === 'admin' ? 'Demote admin' : 'Promote admin'}</button></form><form method="post" action="/admin/users/${user.id}/api-key/rotate" onsubmit="return confirm('Rotate this user API key? The new key is shown once.')"><input type="hidden" name="csrfToken" value="${csrf(c)}"><button class="btn btn-outline-secondary">Rotate API key</button></form></div><div class="row g-3"><div class="col-lg-4"><form method="post" action="/admin/users/${user.id}/password"><input type="hidden" name="csrfToken" value="${csrf(c)}"><label class="form-label">New password</label><input class="form-control" name="password" type="password" minlength="8" required><button class="btn btn-sm btn-primary mt-2">Reset password</button></form></div><div class="col-lg-4"><form method="post" action="/admin/users/${user.id}/recovery-pin"><input type="hidden" name="csrfToken" value="${csrf(c)}"><label class="form-label">New recovery PIN</label><input class="form-control" name="recoveryPin" pattern="\\d{4,12}" required><button class="btn btn-sm btn-primary mt-2">Reset recovery PIN</button></form></div><div class="col-lg-4"><form method="post" action="/admin/users/${user.id}/credits"><input type="hidden" name="csrfToken" value="${csrf(c)}"><label class="form-label">Add/subtract credits</label><input class="form-control" name="amount" type="number" placeholder="+/- credits" required><input class="form-control mt-2" name="description" value="Admin user credit adjustment"><button class="btn btn-sm btn-primary mt-2">Adjust credits</button></form></div></div><hr><form method="post" action="/admin/users/${user.id}/delete" onsubmit="return confirm('Permanently delete this user?')"><input type="hidden" name="csrfToken" value="${csrf(c)}"><label class="form-label">Delete confirmation: type the user email</label><div class="input-group"><input class="form-control" name="confirmation" placeholder="${escapeHtml(user.email)}" ${disabledSelf ? 'disabled' : ''}><button class="btn btn-outline-danger" ${disabledSelf ? 'disabled' : ''}>Delete user</button></div></form></div></div>`;
}

admin.get('/users', async (c) => {
  const search = (c.req.query('q') || '').trim();
  const params = search ? [`%${search}%`] : [];
  const users = await query(`select u.id, u.username, u.email, u.role, u.status, u.created_at, coalesce(b.balance,0)::int balance, coalesce(stats.calls,0)::int calls from users u left join credit_balances b on b.user_id = u.id and b.currency = 'credits' left join (select user_id, count(*) calls from api_usage_logs group by user_id) stats on stats.user_id = u.id ${search ? 'where u.username::text ilike $1 or u.email::text ilike $1' : ''} order by u.created_at desc limit 200`, params);
  const rows = users.rows.map(u => `<tr><td><a href="/admin/users/${u.id}">${escapeHtml(u.email)}</a></td><td>${escapeHtml(u.username)}</td><td>${escapeHtml(u.role)}</td><td>${escapeHtml(u.status)}</td><td>${u.balance}</td><td>${u.calls}</td><td>${u.created_at}</td></tr>`).join('');
  return render(c, 'User management', `<div class="container py-5"><h1 class="fw-bold">User management</h1>${adminNav()}<form class="row g-2 mb-4"><div class="col-md-10"><input class="form-control" name="q" value="${escapeHtml(search)}" placeholder="Search by username or email"></div><div class="col-md-2"><button class="btn btn-primary w-100">Search</button></div></form><div class="table-responsive"><table class="table align-middle"><thead><tr><th>Email</th><th>Username</th><th>Role</th><th>Status</th><th>Credits</th><th>Usage</th><th>Created</th></tr></thead><tbody>${rows}</tbody></table></div></div>`);
});

admin.get('/users/:id', async (c) => {
  const user = await findUser(c.req.param('id')); if (!user) return c.json({ error: 'User not found' }, 404);
  const [apiKeys, usage, purchases, domains, txs, audits] = await Promise.all([
    query(`select id, name, key_prefix, status, scopes, expires_at, last_used_at, created_at, revoked_at from api_keys where user_id = $1 order by created_at desc`, [user.id]),
    query(`select l.created_at, coalesce(e.public_path, l.service_slug, l.request_path) endpoint, l.request_method, l.request_path, l.request_domain, l.response_status, l.credits_charged, l.auth_success, l.failure_reason, l.duration_ms from api_usage_logs l left join proxy_endpoints e on e.id = l.endpoint_id where l.user_id = $1 order by l.created_at desc limit 100`, [user.id]),
    query(`select s.created_at, p.name, s.credits, s.amount_total_cents, s.currency, s.status, s.payment_status, s.stripe_session_id from stripe_checkout_sessions s left join credit_packages p on p.id = s.credit_package_id where s.user_id = $1 order by s.created_at desc limit 100`, [user.id]),
    query(`select domain, status, created_at from allowed_domains where user_id = $1 order by domain`, [user.id]),
    query(`select created_at, transaction_type, amount, balance_after, description, stripe_reference, request_id from credit_transactions where user_id = $1 order by created_at desc limit 50`, [user.id]),
    query(`select created_at, action, metadata from audit_logs where target_user_id = $1 or (entity_type = 'user' and entity_id = $1) order by created_at desc limit 50`, [user.id])
  ]);
  const tr = (rows, cells) => rows.map(r => `<tr>${cells.map(fn => `<td>${fn(r)}</td>`).join('')}</tr>`).join('');
  return render(c, 'User detail', `<div class="container py-5"><h1 class="fw-bold">${escapeHtml(user.email)}</h1>${adminNav()}${userActions(c, user)}<div class="row g-4 mb-4"><div class="col-md-3"><div class="card"><div class="card-body"><span class="text-muted">Status</span><h2>${escapeHtml(user.status)}</h2></div></div></div><div class="col-md-3"><div class="card"><div class="card-body"><span class="text-muted">Role</span><h2>${escapeHtml(user.role)}</h2></div></div></div><div class="col-md-3"><div class="card"><div class="card-body"><span class="text-muted">Balance</span><h2>${user.balance}</h2></div></div></div><div class="col-md-3"><div class="card"><div class="card-body"><span class="text-muted">Used</span><h2>${user.lifetime_used}</h2></div></div></div></div><dl class="row"><dt class="col-sm-3">Username</dt><dd class="col-sm-9">${escapeHtml(user.username)}</dd><dt class="col-sm-3">Created</dt><dd class="col-sm-9">${user.created_at}</dd><dt class="col-sm-3">Wildcard domains</dt><dd class="col-sm-9">${user.wildcard_domains_enabled ? 'Enabled' : 'Disabled'}</dd></dl><h2 class="h5 mt-4">API keys</h2><table class="table table-sm"><thead><tr><th>Name</th><th>Prefix</th><th>Status</th><th>Last used</th><th>Created</th></tr></thead><tbody>${tr(apiKeys.rows, [r=>escapeHtml(r.name), r=>`<code>${escapeHtml(r.key_prefix)}</code>`, r=>escapeHtml(r.status), r=>r.last_used_at || '', r=>r.created_at])}</tbody></table><h2 class="h5 mt-4">Allowed domains</h2><table class="table table-sm"><thead><tr><th>Domain</th><th>Status</th><th>Created</th></tr></thead><tbody>${tr(domains.rows, [r=>escapeHtml(r.domain), r=>escapeHtml(r.status), r=>r.created_at])}</tbody></table><h2 class="h5 mt-4">Usage</h2><table class="table table-sm"><thead><tr><th>Date</th><th>Endpoint</th><th>Request</th><th>Domain</th><th>Status</th><th>Credits</th><th>Auth</th></tr></thead><tbody>${tr(usage.rows, [r=>r.created_at, r=>escapeHtml(r.endpoint || ''), r=>`${escapeHtml(r.request_method)} ${escapeHtml(r.request_path)}`, r=>escapeHtml(r.request_domain || ''), r=>r.response_status ?? '', r=>r.credits_charged, r=>r.auth_success ? 'OK' : escapeHtml(r.failure_reason || 'Failed')])}</tbody></table><h2 class="h5 mt-4">Purchases</h2><table class="table table-sm"><thead><tr><th>Date</th><th>Package</th><th>Credits</th><th>Amount</th><th>Status</th><th>Payment</th><th>Session</th></tr></thead><tbody>${tr(purchases.rows, [r=>r.created_at, r=>escapeHtml(r.name || ''), r=>r.credits, r=>`$${(r.amount_total_cents / 100).toFixed(2)} ${escapeHtml(String(r.currency).toUpperCase())}`, r=>escapeHtml(r.status), r=>escapeHtml(r.payment_status), r=>`<code>${escapeHtml(r.stripe_session_id)}</code>`])}</tbody></table><h2 class="h5 mt-4">Credit transactions</h2><table class="table table-sm"><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Balance</th><th>Description</th><th>Reference</th></tr></thead><tbody>${tr(txs.rows, [r=>r.created_at, r=>escapeHtml(r.transaction_type), r=>r.amount, r=>r.balance_after ?? '', r=>escapeHtml(r.description || ''), r=>escapeHtml(r.stripe_reference || r.request_id || '')])}</tbody></table><h2 class="h5 mt-4">Admin audit logs</h2><table class="table table-sm"><thead><tr><th>Date</th><th>Action</th><th>Metadata</th></tr></thead><tbody>${tr(audits.rows, [r=>r.created_at, r=>escapeHtml(r.action), r=>`<pre class="mb-0 small">${escapeHtml(JSON.stringify(r.metadata, null, 2))}</pre>`])}</tbody></table></div>`);
});

async function adminUserPost(c, schema, handler) { const data = await body(c); if (!csrfOk(c, data)) return c.json({ error: 'Invalid CSRF token' }, 403); const parsed = schema.safeParse(data); if (!parsed.success) return c.json({ errors: parsed.error.issues.map(i => i.message) }, 400); return handler(parsed.data); }
admin.post('/users/:id/status', (c) => adminUserPost(c, z.object({}), async () => { const user = await findUser(c.req.param('id')); if (!user) return c.json({ error: 'User not found' }, 404); if (user.id === c.get('user').id) return c.json({ error: 'You cannot suspend yourself' }, 400); const next = user.status === 'active' ? 'suspended' : 'active'; await query('update users set status = $2 where id = $1', [user.id, next]); await auditUserAction(c, next === 'active' ? 'admin_user_reactivated' : 'admin_user_suspended', user.id, { previousStatus: user.status, status: next }); return c.redirect(`/admin/users/${user.id}`, 303); }));
admin.post('/users/:id/role', (c) => adminUserPost(c, z.object({}), async () => { const user = await findUser(c.req.param('id')); if (!user) return c.json({ error: 'User not found' }, 404); if (user.id === c.get('user').id) return c.json({ error: 'You cannot change your own role' }, 400); const next = user.role === 'admin' ? 'user' : 'admin'; if (next === 'user' && await activeAdminCount(user.id) < 1) return c.json({ error: 'Cannot demote the last active admin' }, 400); await query('update users set role = $2 where id = $1', [user.id, next]); await auditUserAction(c, next === 'admin' ? 'admin_user_promoted' : 'admin_user_demoted', user.id, { previousRole: user.role, role: next }); return c.redirect(`/admin/users/${user.id}`, 303); }));
admin.post('/users/:id/password', (c) => adminUserPost(c, passwordResetSchema, async (data) => { const user = await findUser(c.req.param('id')); if (!user) return c.json({ error: 'User not found' }, 404); await query('update users set password_hash = $2 where id = $1', [user.id, await hashSecret(data.password)]); await auditUserAction(c, 'admin_user_password_reset', user.id); return c.redirect(`/admin/users/${user.id}`, 303); }));
admin.post('/users/:id/recovery-pin', (c) => adminUserPost(c, pinResetSchema, async (data) => { const user = await findUser(c.req.param('id')); if (!user) return c.json({ error: 'User not found' }, 404); const pinHash = await hashSecret(data.recoveryPin); await query('update users set recovery_pin_hash = $2 where id = $1', [user.id, pinHash]); await query(`update recovery_pins set status = 'rotated', revoked_at = now() where user_id = $1 and status = 'active'`, [user.id]); await query('insert into recovery_pins (user_id, pin_hash) values ($1, $2)', [user.id, pinHash]); await auditUserAction(c, 'admin_user_recovery_pin_reset', user.id); return c.redirect(`/admin/users/${user.id}`, 303); }));
admin.post('/users/:id/api-key/rotate', (c) => adminUserPost(c, z.object({}), async () => { const user = await findUser(c.req.param('id')); if (!user) return c.json({ error: 'User not found' }, 404); const rotated = await rotateApiKey(user.id); await auditUserAction(c, 'admin_user_api_key_rotated', user.id, { apiKeyId: rotated.apiKey.id, keyPrefix: rotated.apiKey.key_prefix }); return c.html(`<div class="container py-5"><div class="alert alert-warning"><h1 class="h4">New API key for ${escapeHtml(user.email)}</h1><p>Store this key now. It will only be shown once.</p><code>${escapeHtml(rotated.rawKey)}</code></div><a class="btn btn-primary" href="/admin/users/${user.id}">Back to user</a></div>`); }));
admin.post('/users/:id/credits', (c) => adminUserPost(c, userCreditAdjustSchema, async (data) => { const user = await findUser(c.req.param('id')); if (!user) return c.json({ error: 'User not found' }, 404); await adjustCredits({ userId: user.id, amount: data.amount, description: data.description, createdBy: c.get('user').id }); await auditUserAction(c, 'admin_user_credits_adjusted', user.id, { amount: data.amount, description: data.description }); return c.redirect(`/admin/users/${user.id}`, 303); }));
admin.post('/users/:id/delete', (c) => adminUserPost(c, deleteUserSchema, async (data) => { const user = await findUser(c.req.param('id')); if (!user) return c.json({ error: 'User not found' }, 404); if (user.id === c.get('user').id) return c.json({ error: 'You cannot delete yourself' }, 400); if (user.role === 'admin' && await activeAdminCount(user.id) < 1) return c.json({ error: 'Cannot delete the last active admin' }, 400); if (data.confirmation !== user.email) return c.json({ error: 'Confirmation must match the user email' }, 400); await auditUserAction(c, 'admin_user_deleted', user.id, { email: user.email, username: user.username, role: user.role, status: user.status }); await query('delete from users where id = $1', [user.id]); return c.redirect('/admin/users', 303); }));

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
  try { const saved = await query(sql, id ? [...values, id] : values); await auditAdminChange(c, id ? 'admin_endpoint_updated' : 'admin_endpoint_created', 'proxy_endpoint', saved.rows[0].id, { publicPath: saved.rows[0].public_path, method: saved.rows[0].http_method }); return wantsJson(c) ? c.json({ endpoint: saved.rows[0] }, id ? 200 : 201) : c.redirect(`/admin/endpoints/${saved.rows[0].id}`, 303); }
  catch (error) { return c.json({ errors: [error.code === '23505' ? 'An endpoint with this path and method already exists.' : error.message] }, 400); }
}
admin.post('/endpoints', (c) => saveEndpoint(c));
admin.post('/endpoints/:id', (c) => saveEndpoint(c, c.req.param('id')));
admin.post('/endpoints/:id/toggle', async (c) => { const data = await body(c); if (!csrfOk(c, data)) return c.json({ error: 'Invalid CSRF token' }, 403); await query('update proxy_endpoints set is_enabled = not is_enabled, updated_by = $2 where id = $1', [c.req.param('id'), c.get('user').id]); await auditAdminChange(c, 'admin_endpoint_toggled', 'proxy_endpoint', c.req.param('id')); return c.redirect(`/admin/endpoints/${c.req.param('id')}`, 303); });
admin.post('/endpoints/:id/delete', async (c) => { const data = await body(c); if (!csrfOk(c, data)) return c.json({ error: 'Invalid CSRF token' }, 403); await query('delete from proxy_endpoints where id = $1', [c.req.param('id')]); await auditAdminChange(c, 'admin_endpoint_deleted', 'proxy_endpoint', c.req.param('id')); return c.redirect('/admin/endpoints', 303); });


const packageSchema = z.object({
  name: z.string().trim().min(1).max(120),
  credits: z.coerce.number().int().positive().max(100000000),
  amountCents: z.coerce.number().int().positive().max(100000000),
  currency: z.string().trim().toLowerCase().regex(/^[a-z]{3}$/).default('usd'),
  sortOrder: z.coerce.number().int().min(0).max(100000).default(100),
  isActive: boolFromForm.default(false)
});

admin.get('/billing', async (c) => {
  const [packages, revenue, purchases, events] = await Promise.all([
    query('select * from credit_packages order by sort_order, amount_cents'),
    query(`select count(*)::int purchases, coalesce(sum(amount_total_cents) filter (where payment_status = 'paid'),0)::int revenue_cents, coalesce(sum(credits) filter (where payment_status = 'paid'),0)::int credits_sold from stripe_checkout_sessions`),
    query(`select s.created_at, u.email, p.name, s.credits, s.amount_total_cents, s.currency, s.status, s.payment_status, s.stripe_session_id
             from stripe_checkout_sessions s join users u on u.id = s.user_id left join credit_packages p on p.id = s.credit_package_id
            order by s.created_at desc limit 100`),
    query(`select stripe_event_id, event_type, processing_status, error_message, created_at, processed_at from stripe_webhook_events order by created_at desc limit 50`)
  ]);
  const r = revenue.rows[0];
  const packageRows = packages.rows.map(p => `<tr><form method="post" action="/admin/billing/packages/${p.id}"><td><input class="form-control" name="name" value="${escapeHtml(p.name)}"></td><td><input class="form-control" type="number" name="credits" value="${p.credits}"></td><td><input class="form-control" type="number" name="amountCents" value="${p.amount_cents}"></td><td><input class="form-control" name="currency" value="${escapeHtml(p.currency)}"></td><td><input class="form-control" type="number" name="sortOrder" value="${p.sort_order}"></td><td><input class="form-check-input" type="checkbox" name="isActive" ${p.is_active ? 'checked' : ''}></td><td><input type="hidden" name="csrfToken" value="${csrf(c)}"><button class="btn btn-sm btn-primary">Save</button></td></form></tr>`).join('');
  const purchaseRows = purchases.rows.map(p => `<tr><td>${p.created_at}</td><td>${escapeHtml(p.email)}</td><td>${escapeHtml(p.name || '')}</td><td>${p.credits}</td><td>$${(p.amount_total_cents / 100).toFixed(2)} ${escapeHtml(p.currency.toUpperCase())}</td><td>${escapeHtml(p.status)}</td><td>${escapeHtml(p.payment_status)}</td><td><code>${escapeHtml(p.stripe_session_id)}</code></td></tr>`).join('');
  const eventRows = events.rows.map(e => `<tr><td>${e.created_at}</td><td><code>${escapeHtml(e.stripe_event_id)}</code></td><td>${escapeHtml(e.event_type)}</td><td>${escapeHtml(e.processing_status)}</td><td>${escapeHtml(e.error_message || '')}</td></tr>`).join('');
  return render(c, 'Billing packages & revenue', `<div class="container py-5"><h1 class="fw-bold">Billing packages & revenue</h1>${adminNav()}<div class="row g-4 mb-4"><div class="col-md-4"><div class="card metric-card"><div class="card-body"><span class="text-muted">Paid sessions</span><h2>${r.purchases}</h2></div></div></div><div class="col-md-4"><div class="card metric-card"><div class="card-body"><span class="text-muted">Revenue</span><h2>$${(r.revenue_cents / 100).toFixed(2)}</h2></div></div></div><div class="col-md-4"><div class="card metric-card"><div class="card-body"><span class="text-muted">Credits sold</span><h2>${r.credits_sold}</h2></div></div></div></div><h2 class="h5">Create package</h2><form class="row g-2 mb-4" method="post" action="/admin/billing/packages"><input type="hidden" name="csrfToken" value="${csrf(c)}"><div class="col"><input class="form-control" name="name" placeholder="Package name" required></div><div class="col"><input class="form-control" name="credits" type="number" placeholder="Credits" required></div><div class="col"><input class="form-control" name="amountCents" type="number" placeholder="Amount cents" required></div><div class="col"><input class="form-control" name="currency" value="usd"></div><div class="col"><input class="form-control" name="sortOrder" type="number" value="100"></div><div class="col-auto form-check pt-2"><input class="form-check-input" type="checkbox" name="isActive" checked> Active</div><div class="col-auto"><button class="btn btn-primary">Add</button></div></form><h2 class="h5">Packages</h2><div class="table-responsive mb-5"><table class="table"><thead><tr><th>Name</th><th>Credits</th><th>Amount cents</th><th>Currency</th><th>Sort</th><th>Active</th><th></th></tr></thead><tbody>${packageRows}</tbody></table></div><h2 class="h5">Purchases</h2><div class="table-responsive mb-5"><table class="table"><thead><tr><th>Date</th><th>User</th><th>Package</th><th>Credits</th><th>Amount</th><th>Status</th><th>Payment</th><th>Session</th></tr></thead><tbody>${purchaseRows}</tbody></table></div><h2 class="h5">Stripe webhook events</h2><div class="table-responsive"><table class="table"><thead><tr><th>Date</th><th>Event</th><th>Type</th><th>Status</th><th>Error</th></tr></thead><tbody>${eventRows}</tbody></table></div></div>`);
});

async function savePackage(c, id) {
  const data = await body(c); if (!csrfOk(c, data)) return c.json({ error: 'Invalid CSRF token' }, 403);
  const parsed = packageSchema.safeParse(data); if (!parsed.success) return c.json({ errors: parsed.error.issues.map(i => i.message) }, 400);
  const v = parsed.data;
  let packageId = id;
  if (id) await query(`update credit_packages set name=$1, credits=$2, amount_cents=$3, currency=$4, sort_order=$5, is_active=$6, updated_by=$7 where id=$8`, [v.name, v.credits, v.amountCents, v.currency, v.sortOrder, v.isActive, c.get('user').id, id]);
  else packageId = (await query(`insert into credit_packages (name, credits, amount_cents, currency, sort_order, is_active, created_by, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$7) returning id`, [v.name, v.credits, v.amountCents, v.currency, v.sortOrder, v.isActive, c.get('user').id])).rows[0].id;
  await auditAdminChange(c, id ? 'admin_credit_package_updated' : 'admin_credit_package_created', 'credit_package', packageId, v);
  return c.redirect('/admin/billing', 303);
}
admin.post('/billing/packages', (c) => savePackage(c));
admin.post('/billing/packages/:id', (c) => savePackage(c, c.req.param('id')));

const creditAdjustSchema = z.object({ userId: z.string().uuid(), amount: z.coerce.number().int().min(-1000000).max(1000000).refine(v => v !== 0), description: z.string().trim().max(1000).optional().default('Admin credit adjustment') });

admin.get('/credits', async (c) => {
  const [balances, transactions, day, endpoint, user] = await Promise.all([
    query(`select u.id, u.email, u.username, coalesce(b.balance,0)::int balance, coalesce(b.lifetime_purchased,0)::int lifetime_purchased, coalesce(b.lifetime_used,0)::int lifetime_used from users u left join credit_balances b on b.user_id = u.id and b.currency = 'credits' order by u.created_at desc limit 100`),
    query(`select t.created_at, u.email, t.transaction_type, t.amount, t.balance_after, t.stripe_reference, t.request_id, t.description from credit_transactions t join users u on u.id = t.user_id order by t.created_at desc limit 200`),
    usageSummary({ groupBy: 'day', limit: 30 }), usageSummary({ groupBy: 'endpoint', limit: 30 }), usageSummary({ groupBy: 'user', limit: 30 })
  ]);
  const options = balances.rows.map(u => `<option value="${u.id}">${escapeHtml(u.email)} (${u.balance})</option>`).join('');
  const balanceRows = balances.rows.map(u => `<tr><td>${escapeHtml(u.email)}</td><td>${escapeHtml(u.username)}</td><td>${u.balance}</td><td>${u.lifetime_purchased}</td><td>${u.lifetime_used}</td></tr>`).join('');
  const txRows = transactions.rows.map(t => `<tr><td>${t.created_at}</td><td>${escapeHtml(t.email)}</td><td>${escapeHtml(t.transaction_type)}</td><td>${t.amount}</td><td>${t.balance_after ?? ''}</td><td>${escapeHtml(t.stripe_reference || t.request_id || '')}</td><td>${escapeHtml(t.description || '')}</td></tr>`).join('');
  const summary = (title, rows) => `<div class="col-lg-4"><div class="card h-100"><div class="card-body"><h2 class="h5">${title}</h2><table class="table table-sm"><thead><tr><th>Bucket</th><th>Requests</th><th>Credits</th></tr></thead><tbody>${rows.map(r => `<tr><td>${escapeHtml(r.bucket)}</td><td>${r.transactions}</td><td>${r.credits}</td></tr>`).join('')}</tbody></table></div></div></div>`;
  return render(c, 'Credits admin', `<div class="container py-5"><h1 class="fw-bold">Credits & transactions</h1>${adminNav()}<div class="card mb-4"><div class="card-body"><h2 class="h5">Manual adjustment</h2><form class="row g-2" method="post" action="/admin/credits/adjust"><input type="hidden" name="csrfToken" value="${csrf(c)}"><div class="col-md-4"><select class="form-select" name="userId">${options}</select></div><div class="col-md-2"><input class="form-control" type="number" name="amount" placeholder="+/- credits" required></div><div class="col-md-4"><input class="form-control" name="description" value="Admin credit adjustment"></div><div class="col-md-2"><button class="btn btn-primary w-100">Apply</button></div></form></div></div><div class="row g-4 mb-4">${summary('By day', day)}${summary('By endpoint', endpoint)}${summary('By user', user)}</div><h2 class="h5">Balances</h2><div class="table-responsive"><table class="table"><thead><tr><th>Email</th><th>User</th><th>Balance</th><th>Purchased</th><th>Used</th></tr></thead><tbody>${balanceRows}</tbody></table></div><h2 class="h5 mt-4">All transactions</h2><div class="table-responsive"><table class="table"><thead><tr><th>Date</th><th>User</th><th>Type</th><th>Amount</th><th>Balance after</th><th>Reference</th><th>Description</th></tr></thead><tbody>${txRows}</tbody></table></div></div>`);
});

admin.post('/credits/adjust', async (c) => {
  const data = await body(c); if (!csrfOk(c, data)) return c.json({ error: 'Invalid CSRF token' }, 403);
  const parsed = creditAdjustSchema.safeParse(data); if (!parsed.success) return c.json({ errors: parsed.error.issues.map(i => i.message) }, 400);
  try { await adjustCredits({ userId: parsed.data.userId, amount: parsed.data.amount, description: parsed.data.description, createdBy: c.get('user').id }); await auditAdminChange(c, 'admin_credits_adjusted', 'user', null, { userId: parsed.data.userId, amount: parsed.data.amount, description: parsed.data.description }); }
  catch (error) { return c.json({ error: error.message }, 400); }
  return c.redirect('/admin/credits', 303);
});

admin.get('/api/credits/transactions', async (c) => c.json({ transactions: (await query(`select * from credit_transactions order by created_at desc limit 500`)).rows }));
admin.post('/api/credits/adjust', async (c) => {
  const parsed = creditAdjustSchema.safeParse(await body(c)); if (!parsed.success) return c.json({ errors: parsed.error.issues.map(i => i.message) }, 400);
  try { const adjusted = await adjustCredits({ userId: parsed.data.userId, amount: parsed.data.amount, description: parsed.data.description, createdBy: c.get('user').id }); await auditAdminChange(c, 'admin_credits_adjusted', 'user', null, { userId: parsed.data.userId, amount: parsed.data.amount, description: parsed.data.description }); return c.json(adjusted); }
  catch (error) { return c.json({ error: error.message }, 400); }
});

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
admin.post('/api/endpoints/:id/toggle', async (c) => { await query('update proxy_endpoints set is_enabled = not is_enabled, updated_by = $2 where id = $1 returning *', [c.req.param('id'), c.get('user').id]); await auditAdminChange(c, 'admin_endpoint_toggled', 'proxy_endpoint', c.req.param('id')); return c.json({ ok: true }); });
admin.delete('/api/endpoints/:id', async (c) => { await query('delete from proxy_endpoints where id = $1', [c.req.param('id')]); await auditAdminChange(c, 'admin_endpoint_deleted', 'proxy_endpoint', c.req.param('id')); return c.json({ ok: true }); });
admin.post('/api/test', async (c) => {
  const data = await body(c);
  const parsed = testSchema.safeParse(data); if (!parsed.success) return c.json({ errors: parsed.error.issues.map(i => i.message) }, 400);
  let extraHeaders; try { extraHeaders = parseRequestHeaders(parsed.data.headers); } catch (error) { return c.json({ errors: [error.message] }, 400); }
  const started = performance.now(); const url = new URL(parsed.data.requestPath, new URL(c.req.url).origin);
  const response = await fetch(url, { method: parsed.data.method, headers: extraHeaders, body: ['GET', 'HEAD'].includes(parsed.data.method) ? undefined : parsed.data.body });
  const text = await response.text();
  return c.json({ status: response.status, durationMs: Math.round(performance.now() - started), headers: Object.fromEntries(response.headers.entries()), body: text.slice(0, 20000) });
});
