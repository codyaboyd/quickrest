import { Hono } from 'hono';
import { html } from 'hono/html';
import { getCookie, setCookie } from 'hono/cookie';
import { randomBytes } from 'node:crypto';
import { layout } from '../templates/layout.js';
import { CSRF_COOKIE } from '../services/authService.js';
import { requireAuth } from '../middleware/auth.js';
import { query } from '../db/postgres.js';

export const pages = new Hono();

function csrfToken(c) {
  const existing = getCookie(c, CSRF_COOKIE);
  if (existing) return existing;
  const token = randomBytes(32).toString('base64url');
  setCookie(c, CSRF_COOKIE, token, { httpOnly: false, secure: c.req.url.startsWith('https:'), sameSite: 'Lax', path: '/', maxAge: 60 * 60 * 24 * 7 });
  return token;
}

function escapeHtml(value = '') { return String(value).replace(/[&<>\"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' }[ch])); }

function render(c, title, children) {
  return c.html(html`${layout({ title, children, user: c.get('user') })}`);
}

pages.get('/', (c) => render(c, 'Paid API proxy platform', `
<section class="hero text-white"><div class="container py-5"><div class="row align-items-center g-5 py-4"><div class="col-lg-7"><span class="badge text-bg-primary mb-3">Bun + Hono + PostgreSQL + Redis</span><h1 class="display-4 fw-bold">Sell one central API that proxies every upstream service.</h1><p class="lead text-white-50 mt-3">QuickRest combines backend APIs behind a single gateway, validates customers, tracks credits, and gives SaaS teams a clean place to meter usage.</p><div class="d-flex gap-3 mt-4 flex-wrap"><a href="/dashboard" class="btn btn-primary btn-lg">Open dashboard</a><a href="/api/proxy/httpbin?hello=quickrest" class="btn btn-outline-light btn-lg">Try demo proxy</a></div></div><div class="col-lg-5"><div class="card shadow-lg border-0 api-card"><div class="card-body p-4"><p class="text-uppercase text-muted small mb-2">Gateway request</p><pre class="mb-0"><code>GET /api/proxy/weather\nAuthorization: Bearer qrst_...\nX-Credits-Cost: 1</code></pre></div></div></div></div></div></section>
<section class="container py-5"><div class="row g-4">${['API aggregation', 'Credit billing', 'Rate limiting'].map((title) => `<div class="col-md-4"><div class="card h-100 shadow-sm"><div class="card-body"><h2 class="h5">${title}</h2><p class="text-muted mb-0">Configure upstream services, control customer access, and protect infrastructure with Redis-backed limits.</p></div></div></div>`).join('')}</div></section>`));

pages.get('/signup', (c) => render(c, 'Sign up', `
<div class="container py-5 auth-page"><div class="row justify-content-center"><div class="col-lg-6"><div class="card shadow-sm"><div class="card-body p-4"><h1 class="h3 mb-3">Create your account</h1><form class="needs-validation" method="post" action="/auth/signup" novalidate><input type="hidden" name="csrfToken" value="${csrfToken(c)}"><div class="mb-3"><label class="form-label">Username</label><input class="form-control" name="username" minlength="3" maxlength="64" pattern="[A-Za-z0-9_-]+" data-check-username required><div class="form-text" data-username-feedback>Use 3-64 letters, numbers, underscores, or hyphens.</div></div><div class="mb-3"><label class="form-label">Email</label><input class="form-control" type="email" name="email" data-check-email required><div class="form-text" data-email-feedback>We will verify this email is unique.</div></div><div class="mb-3"><label class="form-label">Password</label><input class="form-control" type="password" name="password" minlength="8" required><div class="invalid-feedback">Use at least 8 characters.</div></div><div class="mb-3"><label class="form-label">Recovery PIN</label><input class="form-control" name="recoveryPin" inputmode="numeric" pattern="\\d{4,12}" required><div class="form-text">Recovery PINs are hashed like passwords. Store yours somewhere safe; support cannot read it.</div></div><button class="btn btn-primary w-100">Sign up</button></form></div></div></div></div></div>`));

pages.get('/login', (c) => render(c, 'Login', `
<div class="container py-5 auth-page"><div class="row justify-content-center"><div class="col-lg-5"><div class="card shadow-sm"><div class="card-body p-4"><h1 class="h3 mb-3">Login</h1>${c.req.query('error') ? `<div class="alert alert-danger">${c.req.query('error')}</div>` : ''}<form class="needs-validation" method="post" action="/auth/login" novalidate><input type="hidden" name="csrfToken" value="${csrfToken(c)}"><div class="mb-3"><label class="form-label">Email</label><input class="form-control" type="email" name="email" required></div><div class="mb-3"><label class="form-label">Password</label><input class="form-control" type="password" name="password" minlength="8" required></div><button class="btn btn-primary w-100">Login</button></form></div></div></div></div></div>`));

pages.get('/logout', requireAuth, (c) => render(c, 'Logout', `<div class="container py-5"><div class="card shadow-sm"><div class="card-body"><h1 class="h3">Logout</h1><p>End your current session?</p><form method="post" action="/auth/logout"><input type="hidden" name="csrfToken" value="${csrfToken(c)}"><button class="btn btn-danger">Logout</button></form></div></div></div>`));

pages.get('/account', requireAuth, (c) => render(c, 'Account settings', `<div class="container py-5"><h1 class="fw-bold">Account settings</h1><div class="card shadow-sm"><div class="card-body"><dl class="row mb-0"><dt class="col-sm-3">Username</dt><dd class="col-sm-9">${escapeHtml(c.get('user').username)}</dd><dt class="col-sm-3">Email</dt><dd class="col-sm-9">${escapeHtml(c.get('user').email)}</dd><dt class="col-sm-3">Role</dt><dd class="col-sm-9"><span class="badge text-bg-secondary">${escapeHtml(c.get('user').role)}</span></dd><dt class="col-sm-3">Status</dt><dd class="col-sm-9">${escapeHtml(c.get('user').status)}</dd></dl></div></div></div>`));

function nav() { return `<div class="list-group mb-4"><a class="list-group-item" href="/dashboard">Customer dashboard</a><a class="list-group-item" href="/api-key">API key</a><a class="list-group-item" href="/domains">Allowed domains</a><a class="list-group-item" href="/credits">Credits</a><a class="list-group-item" href="/usage">Usage logs</a><a class="list-group-item" href="/account">Account settings</a></div>`; }

pages.get('/dashboard', requireAuth, async (c) => {
  const userId = c.get('user').id;
  const [balance, usage, purchases] = await Promise.all([
    query('select balance, lifetime_purchased, lifetime_used from credit_balances where user_id = $1 and currency = $2', [userId, 'credits']),
    query('select count(*)::int as count from api_usage_logs where user_id = $1', [userId]),
    query(`select coalesce(sum(amount),0)::int as total from credit_transactions where user_id = $1 and transaction_type = 'purchase'`, [userId])
  ]);
  const b = balance.rows[0] || { balance: 0, lifetime_purchased: 0, lifetime_used: 0 };
  return render(c, 'Customer dashboard', `<div class="container py-5"><h1 class="fw-bold mb-4">Customer dashboard</h1>${nav()}<div class="row g-4"><div class="col-md-4"><div class="card metric-card"><div class="card-body"><span class="text-muted">Credit balance</span><h2>${b.balance}</h2></div></div></div><div class="col-md-4"><div class="card metric-card"><div class="card-body"><span class="text-muted">API calls</span><h2>${usage.rows[0].count}</h2></div></div></div><div class="col-md-4"><div class="card metric-card"><div class="card-body"><span class="text-muted">Purchased</span><h2>${purchases.rows[0].total}</h2></div></div></div></div></div>`);
});

pages.get('/api-key', requireAuth, async (c) => {
  const keys = await query('select id, name, key_prefix, status, last_used_at, created_at from api_keys where user_id = $1 order by created_at desc', [c.get('user').id]);
  const rows = keys.rows.map(k => `<tr><td>${escapeHtml(k.name)}</td><td><code>${escapeHtml(k.key_prefix)}…</code></td><td>${escapeHtml(k.status)}</td><td>${k.last_used_at || 'Never'}</td><td>${k.created_at}</td></tr>`).join('');
  return render(c, 'API key', `<div class="container py-5"><h1 class="fw-bold">API key</h1>${nav()}<div class="alert alert-info">Raw API keys are shown only once when generated. Rotate to receive a new key.</div><form method="post" action="/customer/api-key/rotate"><input type="hidden" name="csrfToken" value="${csrfToken(c)}"><button class="btn btn-warning mb-3">Rotate API key</button></form><div class="table-responsive"><table class="table"><thead><tr><th>Name</th><th>Prefix</th><th>Status</th><th>Last used</th><th>Created</th></tr></thead><tbody>${rows}</tbody></table></div></div>`);
});

pages.get('/domains', requireAuth, async (c) => {
  const user = (await query('select wildcard_domains_enabled from users where id = $1', [c.get('user').id])).rows[0];
  const domains = await query('select id, domain, status, created_at from allowed_domains where user_id = $1 order by created_at desc', [c.get('user').id]);
  const rows = domains.rows.map(d => `<tr><form method="post" action="/customer/domains/${d.id}"><td><input class="form-control" name="domain" value="${escapeHtml(d.domain)}"></td><td><select class="form-select" name="status"><option ${d.status==='active'?'selected':''}>active</option><option ${d.status==='disabled'?'selected':''}>disabled</option></select></td><td><input type="hidden" name="csrfToken" value="${csrfToken(c)}"><button class="btn btn-sm btn-primary">Save</button></form><form class="d-inline" method="post" action="/customer/domains/${d.id}/delete"><input type="hidden" name="csrfToken" value="${csrfToken(c)}"><button class="btn btn-sm btn-outline-danger">Delete</button></form></td></tr>`).join('');
  return render(c, 'Allowed domains', `<div class="container py-5"><h1 class="fw-bold">Allowed domains</h1>${nav()}<form method="post" action="/customer/domains/wildcard" class="form-check form-switch mb-3"><input type="hidden" name="csrfToken" value="${csrfToken(c)}"><input class="form-check-input" type="checkbox" name="enabled" onchange="this.form.submit()" ${user?.wildcard_domains_enabled?'checked':''}><label class="form-check-label">Allow wildcard access from any domain</label></form><form class="row g-2 mb-4" method="post" action="/customer/domains"><input type="hidden" name="csrfToken" value="${csrfToken(c)}"><div class="col"><input class="form-control" name="domain" placeholder="example.com or *.example.com" required></div><div class="col-auto"><button class="btn btn-primary">Add domain</button></div></form><table class="table"><thead><tr><th>Domain</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`);
});

pages.get('/credits', requireAuth, async (c) => {
  const b = (await query('select balance, lifetime_purchased, lifetime_used from credit_balances where user_id = $1', [c.get('user').id])).rows[0] || { balance: 0, lifetime_purchased: 0, lifetime_used: 0 };
  const txs = await query(`select transaction_type, amount, balance_after, stripe_reference, request_id, description, created_at from credit_transactions where user_id = $1 order by created_at desc limit 100`, [c.get('user').id]);
  const rows = txs.rows.map(t => `<tr><td>${t.created_at}</td><td><span class="badge text-bg-secondary">${escapeHtml(t.transaction_type)}</span></td><td>${t.amount}</td><td>${t.balance_after ?? ''}</td><td>${escapeHtml(t.stripe_reference || t.request_id || '')}</td><td>${escapeHtml(t.description || '')}</td></tr>`).join('');
  return render(c, 'Credits', `<div class="container py-5"><h1 class="fw-bold">Credits</h1>${nav()}<div class="card mb-4"><div class="card-body"><h2>${b.balance} credits</h2><p class="text-muted">Lifetime purchased: ${b.lifetime_purchased}. Lifetime used: ${b.lifetime_used}.</p></div></div><h2 class="h5">Credit history</h2><div class="table-responsive"><table class="table"><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Balance after</th><th>Reference</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table></div></div>`);
});

pages.get('/usage', requireAuth, async (c) => {
  const logs = await query('select service_slug, request_method, request_path, request_domain, response_status, credits_charged, auth_success, failure_reason, created_at from api_usage_logs where user_id = $1 order by created_at desc limit 100', [c.get('user').id]);
  const rows = logs.rows.map(l => `<tr><td>${l.created_at}</td><td>${escapeHtml(l.service_slug || '')}</td><td>${escapeHtml(l.request_method)} ${escapeHtml(l.request_path)}</td><td>${escapeHtml(l.request_domain || '')}</td><td>${l.response_status ?? ''}</td><td>${l.credits_charged}</td><td>${l.auth_success ? 'OK' : escapeHtml(l.failure_reason || 'Failed')}</td></tr>`).join('');
  return render(c, 'Usage logs', `<div class="container py-5"><h1 class="fw-bold">Usage logs</h1>${nav()}<div class="table-responsive"><table class="table"><thead><tr><th>Date</th><th>Service</th><th>Request</th><th>Domain</th><th>Status</th><th>Credits</th><th>Auth</th></tr></thead><tbody>${rows}</tbody></table></div></div>`);
});
