import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { HTTPException } from 'hono/http-exception';
import { env, isProduction } from './config/env.js';
import { requestLogger } from './middleware/logger.js';
import { rateLimit } from './middleware/rateLimit.js';
import { loadSession } from './middleware/auth.js';
import { maintenanceMode } from './middleware/maintenanceMode.js';
import { api, healthHandler } from './routes/api.js';
import { auth } from './routes/auth.js';
import { pages } from './routes/pages.js';
import { customer } from './routes/customer.js';
import { admin } from './routes/admin.js';
import { billing, stripeWebhook } from './routes/billing.js';
import { handleDynamicProxy } from './services/proxyEngine.js';

const app = new Hono();

app.use('*', requestLogger);
app.use('/api/*', rateLimit());
app.route('/webhooks', stripeWebhook);
app.use('*', loadSession);
app.use('*', maintenanceMode());
app.use('/assets/*', serveStatic({ root: './public' }));

app.get('/health', healthHandler);
app.route('/auth', auth);
app.route('/', pages);
app.route('/customer', customer);
app.route('/admin', admin);
app.route('/billing', billing);
app.route('/api', api);

app.all('*', async (c, next) => {
  const response = await handleDynamicProxy(c);
  if (response) return response;
  await next();
});

app.notFound((c) => c.json({ error: 'Not found', requestId: c.get('requestId') }, 404));

app.onError((error, c) => {
  const requestId = c.get('requestId');
  if (error instanceof HTTPException) {
    return c.json({ error: error.message, requestId }, error.status);
  }

  console.error('Unhandled error', { requestId, error });
  return c.json({
    error: isProduction ? 'Internal server error' : error.message,
    requestId
  }, 500);
});

if (import.meta.main) {
  serve({ fetch: app.fetch, port: env.PORT });
  console.log(`${env.APP_NAME} listening on ${env.APP_URL}`);
}

export { app };
