import Redis from 'ioredis';
import { env } from '../config/env.js';

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 2,
  enableReadyCheck: true
});

redis.on('error', (error) => {
  console.error('Redis error', error.message);
});

export async function checkRedis() {
  return (await redis.ping()) === 'PONG';
}
