import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { HTTPException } from 'hono/http-exception';
import { env, isProduction } from './config/env.js';
import { requestLogger } from './middleware/logger.js';
import { rateLimit } from './middleware/rateLimit.js';
import { api, healthHandler } from './routes/api.js';
import { pages } from './routes/pages.js';

const app = new Hono();

app.use('*', requestLogger);
app.use('/api/*', rateLimit());
app.use('/assets/*', serveStatic({ root: './public' }));

app.get('/health', healthHandler);
app.route('/', pages);
app.route('/api', api);

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
