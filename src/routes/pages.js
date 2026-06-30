import { Hono } from 'hono';
import { html } from 'hono/html';
import { layout } from '../templates/layout.js';
import { listDemoServices } from '../services/proxyService.js';

export const pages = new Hono();

pages.get('/', (c) => c.html(html`${layout({ title: 'Paid API proxy platform', children: `
<section class="hero text-white">
  <div class="container py-5">
    <div class="row align-items-center g-5 py-4">
      <div class="col-lg-7">
        <span class="badge text-bg-primary mb-3">Bun + Hono + PostgreSQL + Redis</span>
        <h1 class="display-4 fw-bold">Sell one central API that proxies every upstream service.</h1>
        <p class="lead text-white-50 mt-3">QuickRest combines backend APIs behind a single gateway, validates customers, tracks credits, and gives SaaS teams a clean place to meter usage.</p>
        <div class="d-flex gap-3 mt-4 flex-wrap">
          <a href="/dashboard" class="btn btn-primary btn-lg">Open dashboard</a>
          <a href="/api/proxy/httpbin?hello=quickrest" class="btn btn-outline-light btn-lg">Try demo proxy</a>
        </div>
      </div>
      <div class="col-lg-5">
        <div class="card shadow-lg border-0 api-card">
          <div class="card-body p-4">
            <p class="text-uppercase text-muted small mb-2">Gateway request</p>
            <pre class="mb-0"><code>GET /api/proxy/weather\nAuthorization: Bearer qrst_...\nX-Credits-Cost: 1</code></pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>
<section class="container py-5">
  <div class="row g-4">
    ${['API aggregation', 'Credit billing', 'Rate limiting'].map((title) => `<div class="col-md-4"><div class="card h-100 shadow-sm"><div class="card-body"><h2 class="h5">${title}</h2><p class="text-muted mb-0">Configure upstream services, control customer access, and protect infrastructure with Redis-backed limits.</p></div></div></div>`).join('')}
  </div>
</section>` })}`));

pages.get('/dashboard', (c) => {
  const rows = listDemoServices().map((service) => `<tr><td>${service.name}</td><td><code>${service.slug}</code></td><td>${service.creditCost}</td><td><span class="badge text-bg-success">Active</span></td></tr>`).join('');
  return c.html(html`${layout({ title: 'Dashboard', children: `
<div class="container py-5">
  <div class="d-flex justify-content-between align-items-center flex-wrap gap-3 mb-4">
    <div><h1 class="fw-bold mb-1">Proxy dashboard</h1><p class="text-muted mb-0">Starter control plane for services, credits, keys, and usage.</p></div>
    <button class="btn btn-primary" data-bs-toggle="modal" data-bs-target="#serviceModal">Add service</button>
  </div>
  <div class="row g-4 mb-4">
    <div class="col-md-4"><div class="card metric-card"><div class="card-body"><span class="text-muted">Credits issued</span><h2>25,000</h2></div></div></div>
    <div class="col-md-4"><div class="card metric-card"><div class="card-body"><span class="text-muted">Requests proxied</span><h2>8,421</h2></div></div></div>
    <div class="col-md-4"><div class="card metric-card"><div class="card-body"><span class="text-muted">Active services</span><h2>${listDemoServices().length}</h2></div></div></div>
  </div>
  <div class="card shadow-sm"><div class="card-body"><h2 class="h5 mb-3">API services</h2><div class="table-responsive"><table class="table align-middle"><thead><tr><th>Name</th><th>Slug</th><th>Credit cost</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div></div></div>
</div>
<div class="modal fade" id="serviceModal" tabindex="-1" aria-hidden="true"><div class="modal-dialog"><div class="modal-content"><div class="modal-header"><h2 class="modal-title h5">Add upstream service</h2><button class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div><div class="modal-body"><p class="text-muted">Wire this form to the PostgreSQL-backed service model as the next build step.</p></div></div></div></div>` })}`);
});
