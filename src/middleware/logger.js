export async function requestLogger(c, next) {
  const startedAt = performance.now();
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('X-Request-Id', requestId);

  await next();

  const durationMs = Math.round(performance.now() - startedAt);
  console.info(JSON.stringify({
    requestId,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status: c.res.status,
    durationMs
  }));
}
