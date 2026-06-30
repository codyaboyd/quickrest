import { env } from '../config/env.js';
import { redis } from '../lib/redis.js';
import { getSetting } from '../services/adminSettingsService.js';

export function rateLimit({ prefix = 'rl', max = env.RATE_LIMIT_MAX_REQUESTS, windowSeconds = env.RATE_LIMIT_WINDOW_SECONDS } = {}) {
  return async (c, next) => {
    const configured = prefix === 'rl' ? await getSetting('limits.global_requests', null).catch(() => null) : null;
    const effectiveMax = Number(configured?.max_requests || max);
    const effectiveWindowSeconds = Number(configured?.window_seconds || windowSeconds);
    const forwardedFor = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    const ip = forwardedFor || c.req.header('x-real-ip') || 'anonymous';
    const key = `${prefix}:${ip}`;
    const count = await redis.incr(key);

    if (count === 1) {
      await redis.expire(key, effectiveWindowSeconds);
    }

    c.header('X-RateLimit-Limit', String(effectiveMax));
    c.header('X-RateLimit-Remaining', String(Math.max(effectiveMax - count, 0)));

    if (count > effectiveMax) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    await next();
  };
}
