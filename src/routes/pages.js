import { Hono } from 'hono';
import { html } from 'hono/html';
import { getCookie, setCookie } from 'hono/cookie';
import { randomBytes } from 'node:crypto';
import { layout } from '../templates/layout.js';
import { listDemoServices } from '../services/proxyService.js';
import { CSRF_COOKIE } from '../services/authService.js';
import { requireAuth } from '../middleware/auth.js';

export const pages = new Hono();

function csrfToken(c) {
  const existing = getCookie(c, CSRF_COOKIE);
  if (existing) return existing;
  const token = randomBytes(32).toString('base64url');
  setCookie(c, CSRF_COOKIE, token, { httpOnly: false, secure: c.req.url.startsWith('https:'), sameSite: 'Lax', path: '/', maxAge: 60 * 60 * 24 * 7 });
  return token;
}

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

pages.get('/account', requireAuth, (c) => render(c, 'Account settings', `<div class="container py-5"><h1 class="fw-bold">Account settings</h1><div class="card shadow-sm"><div class="card-body"><dl class="row mb-0"><dt class="col-sm-3">Username</dt><dd class="col-sm-9">${c.get('user').username}</dd><dt class="col-sm-3">Email</dt><dd class="col-sm-9">${c.get('user').email}</dd><dt class="col-sm-3">Role</dt><dd class="col-sm-9"><span class="badge text-bg-secondary">${c.get('user').role}</span></dd><dt class="col-sm-3">Recovery PIN</dt><dd class="col-sm-9">Your PIN is securely hashed and cannot be displayed. A reset workflow can rotate it later.</dd></dl></div></div></div>`));

pages.get('/dashboard', requireAuth, (c) => {
  const rows = listDemoServices().map((service) => `<tr><td>${service.name}</td><td><code>${service.slug}</code></td><td>${service.creditCost}</td><td><span class="badge text-bg-success">Active</span></td></tr>`).join('');
  return render(c, 'Dashboard', `<div class="container py-5"><div class="d-flex justify-content-between align-items-center flex-wrap gap-3 mb-4"><div><h1 class="fw-bold mb-1">Proxy dashboard</h1><p class="text-muted mb-0">Starter control plane for services, credits, keys, and usage.</p></div><button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#serviceModal">Add service</button></div><div class="row g-4 mb-4"><div class="col-md-4"><div class="card metric-card"><div class="card-body"><span class="text-muted">Credits issued</span><h2>25,000</h2></div></div></div><div class="col-md-4"><div class="card metric-card"><div class="card-body"><span class="text-muted">Requests proxied</span><h2>8,421</h2></div></div></div><div class="col-md-4"><div class="card metric-card"><div class="card-body"><span class="text-muted">Active services</span><h2>${listDemoServices().length}</h2></div></div></div></div><div class="card shadow-sm"><div class="card-body"><h2 class="h5 mb-3">API services</h2><div class="table-responsive"><table class="table align-middle"><thead><tr><th>Name</th><th>Slug</th><th>Credit cost</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div></div></div></div>`);
});
