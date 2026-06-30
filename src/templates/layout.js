import { env } from '../config/env.js';

export function layout({ title, children }) {
  const pageTitle = title ? `${title} · ${env.APP_NAME}` : env.APP_NAME;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${pageTitle}</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="/assets/css/app.css" rel="stylesheet">
</head>
<body>
  <nav class="navbar navbar-expand-lg navbar-dark bg-dark border-bottom border-primary">
    <div class="container">
      <a class="navbar-brand fw-bold" href="/">${env.APP_NAME}</a>
      <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#navbarNav" aria-controls="navbarNav" aria-expanded="false" aria-label="Toggle navigation">
        <span class="navbar-toggler-icon"></span>
      </button>
      <div class="collapse navbar-collapse" id="navbarNav">
        <ul class="navbar-nav ms-auto">
          <li class="nav-item"><a class="nav-link" href="/dashboard">Dashboard</a></li>
          <li class="nav-item"><a class="nav-link" href="/health">Health</a></li>
        </ul>
      </div>
    </div>
  </nav>
  <main>${children}</main>
  <footer class="py-4 bg-body-tertiary border-top">
    <div class="container small text-muted d-flex justify-content-between flex-wrap gap-2">
      <span>© ${new Date().getFullYear()} ${env.APP_NAME}</span>
      <span>Centralized API access, metering, and proxy controls.</span>
    </div>
  </footer>
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
  <script src="/assets/js/app.js"></script>
</body>
</html>`;
}
