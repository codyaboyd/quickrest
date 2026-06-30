import { env } from '../config/env.js';
import { redis } from '../lib/redis.js';

export function rateLimit({ prefix = 'rl', max = env.RATE_LIMIT_MAX_REQUESTS, windowSeconds = env.RATE_LIMIT_WINDOW_SECONDS } = {}) {
  return async (c, next) => {
    const forwardedFor = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    const ip = forwardedFor || c.req.header('x-real-ip') || 'anonymous';
    const key = `${prefix}:${ip}`;
    const count = await redis.incr(key);

    if (count === 1) {
      await redis.expire(key, windowSeconds);
    }

    c.header('X-RateLimit-Limit', String(max));
    c.header('X-RateLimit-Remaining', String(Math.max(max - count, 0)));

    if (count > max) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    await next();
  };
}
