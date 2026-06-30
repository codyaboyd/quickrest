import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { env, isProduction } from '../config/env.js';
import { query } from '../db/postgres.js';
import { redis } from '../lib/redis.js';

export const SESSION_COOKIE = 'quickrest_session';
export const CSRF_COOKIE = 'quickrest_csrf';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

function sign(value) {
  return createHmac('sha256', env.SESSION_SECRET).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function encodeSession(id) {
  return `${id}.${sign(id)}`;
}

function decodeSession(cookie) {
  if (!cookie) return null;
  const [id, mac] = cookie.split('.');
  if (!id || !mac || !safeEqual(sign(id), mac)) return null;
  return id;
}

function cookieOptions() {
  return { httpOnly: true, secure: isProduction, sameSite: 'Lax', path: '/', maxAge: SESSION_TTL_SECONDS };
}

function csrfCookieOptions() {
  return { httpOnly: false, secure: isProduction, sameSite: 'Lax', path: '/', maxAge: SESSION_TTL_SECONDS };
}

export async function hashSecret(secret) {
  return argon2.hash(secret, { type: argon2.argon2id });
}

export async function verifySecret(hash, secret) {
  return argon2.verify(hash, secret);
}

export async function createSession(c, user) {
  const id = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  await redis.set(`session:${id}`, JSON.stringify({ userId: user.id, csrfToken }), 'EX', SESSION_TTL_SECONDS);
  setCookie(c, SESSION_COOKIE, encodeSession(id), cookieOptions());
  setCookie(c, CSRF_COOKIE, csrfToken, csrfCookieOptions());
  return { id, csrfToken };
}

export async function destroySession(c) {
  const id = decodeSession(getCookie(c, SESSION_COOKIE));
  if (id) await redis.del(`session:${id}`);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  deleteCookie(c, CSRF_COOKIE, { path: '/' });
}

export async function loadSession(c, next) {
  const id = decodeSession(getCookie(c, SESSION_COOKIE));
  c.set('session', null);
  c.set('user', null);
  if (id) {
    const raw = await redis.get(`session:${id}`);
    if (raw) {
      const session = JSON.parse(raw);
      const result = await query('select id, username, email, role, status, created_at from users where id = $1', [session.userId]);
      const user = result.rows[0];
      if (user && user.status === 'active') {
        await redis.expire(`session:${id}`, SESSION_TTL_SECONDS);
        c.set('session', { id, ...session });
        c.set('user', user);
      } else {
        await redis.del(`session:${id}`);
      }
    }
  }
  await next();
}

export async function requireAuth(c, next) {
  if (!c.get('user')) throw new HTTPException(401, { message: 'Authentication required' });
  await next();
}

export async function requireAdmin(c, next) {
  const user = c.get('user');
  if (!user) throw new HTTPException(401, { message: 'Authentication required' });
  if (user.role !== 'admin') throw new HTTPException(403, { message: 'Admin access required' });
  await next();
}

export async function requireCsrf(c, next) {
  const session = c.get('session');
  if (!session) throw new HTTPException(401, { message: 'Authentication required' });
  const token = c.req.header('x-csrf-token') || (await c.req.parseBody()).csrfToken;
  if (!token || token !== session.csrfToken) throw new HTTPException(403, { message: 'Invalid CSRF token' });
  await next();
}
