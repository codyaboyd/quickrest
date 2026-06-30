import { Hono } from 'hono';
import { checkPostgres } from '../db/postgres.js';
import { checkRedis } from '../lib/redis.js';
import { listDemoServices, proxyRequest } from '../services/proxyService.js';

export const api = new Hono();

api.get('/services', (c) => c.json({ services: listDemoServices() }));
api.all('/proxy/:service', async (c) => {
  const result = await proxyRequest(c.req.param('service'), c.req.raw, c);
  return c.json(result.body, result.status);
});

export async function healthHandler(c) {
  const checks = await Promise.allSettled([checkPostgres(), checkRedis()]);
  const postgres = checks[0].status === 'fulfilled' && checks[0].value;
  const redis = checks[1].status === 'fulfilled' && checks[1].value;
  const ok = postgres && redis;

  return c.json({
    status: ok ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    services: { postgres, redis }
  }, ok ? 200 : 503);
}
