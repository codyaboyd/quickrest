import { Hono } from 'hono';
import { z } from 'zod';
import { getCookie } from 'hono/cookie';
import { randomBytes, createHash } from 'node:crypto';
import { query } from '../db/postgres.js';
import { CSRF_COOKIE, createSession, destroySession, hashSecret, verifySecret } from '../services/authService.js';
import { redis } from '../lib/redis.js';
import { ensureUserApiKey } from '../services/apiKeyService.js';
import { ensureCreditBalance, adjustCredits } from '../services/creditService.js';
import { getSetting } from '../services/adminSettingsService.js';
import { safeEqualString } from '../services/security.js';
import { ERROR_CODES, clientIp, enforceNamedThrottle, errorPayload, logSuspiciousUsage } from '../services/apiProtectionService.js';

export const auth = new Hono();

const usernameSchema = z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9_-]+$/, 'Use letters, numbers, underscores, or hyphens');
const emailSchema = z.string().trim().email().max(254).toLowerCase();
const passwordSchema = z.string().min(8).max(256);
const pinSchema = z.string().trim().regex(/^\d{4,12}$/, 'Use a 4-12 digit recovery PIN');

function csrfOk(c, body) {
  const cookieToken = getCookie(c, CSRF_COOKIE);
  const token = c.req.header('x-csrf-token') || body?.csrfToken;
  return Boolean(cookieToken && token && safeEqualString(cookieToken, token));
}

function wantsHtml(c) {
  return c.req.header('accept')?.includes('text/html');
}

async function body(c) {
  const type = c.req.header('content-type') || '';
  return type.includes('application/json') ? await c.req.json() : await c.req.parseBody();
}


const RECOVERY_SESSION_TTL_SECONDS = 15 * 60;
const RECOVERY_LOCK_SECONDS = 15 * 60;
const RECOVERY_MAX_FAILED_PIN_ATTEMPTS = 5;
const recoveryIdentitySchema = z.string().trim().min(3).max(254);
const resetSessionSchema = z.string().trim().min(24).max(256);

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function recoverySessionKey(token) { return `password-recovery:${sha256(token)}`; }
function recoveryFailKey(userId) { return `password-recovery-fail:${userId}`; }
function recoveryLockKey(userId) { return `password-recovery-lock:${userId}`; }
function ipForDb(c) { return clientIp(c) === 'anonymous' ? '' : clientIp(c); }
async function logRecoveryEvent(c, { userId = null, action, metadata = {} }) {
  await query(`insert into audit_logs (actor_user_id, target_user_id, action, entity_type, entity_id, ip_address, user_agent, metadata) values (null,$1,$2,'password_recovery',$1,nullif($3, '')::inet,$4,$5::jsonb)`, [userId, action, ipForDb(c), c.req.header('user-agent') || '', JSON.stringify(metadata)]).catch((error) => console.error('Failed to log recovery event', error.message));
}
async function createRecoverySession(userId) {
  const token = randomBytes(32).toString('base64url');
  await redis.set(recoverySessionKey(token), JSON.stringify({ userId }), 'EX', RECOVERY_SESSION_TTL_SECONDS);
  return token;
}
async function loadRecoverySession(token) {
  if (!token) return null;
  const raw = await redis.get(recoverySessionKey(token));
  return raw ? JSON.parse(raw) : null;
}
function recoveryFail(c, message, status = 400) {
  if (wantsHtml(c)) return c.redirect(`/forgot-password?error=${encodeURIComponent(message)}`, 303);
  return c.json(errorPayload('PASSWORD_RECOVERY_ERROR', message, c.get('requestId')), status);
}

function fail(c, message, status = 400, code = 'AUTH_ERROR') {
  if (wantsHtml(c)) return c.redirect(`/login?error=${encodeURIComponent(message)}`, 303);
  return c.json(errorPayload(code, message, c.get('requestId')), status);
}

auth.get('/check-username', async (c) => {
  const username = usernameSchema.safeParse(c.req.query('username') || '');
  if (!username.success) return c.json({ available: false, error: username.error.issues[0]?.message }, 400);
  const existing = await query('select 1 from users where username = $1 limit 1', [username.data]);
  return c.json({ username: username.data, available: existing.rowCount === 0 });
});

auth.get('/check-email', async (c) => {
  const email = emailSchema.safeParse(c.req.query('email') || '');
  if (!email.success) return c.json({ available: false, error: 'Enter a valid email address' }, 400);
  const existing = await query('select 1 from users where email = $1 limit 1', [email.data]);
  return c.json({ email: email.data, available: existing.rowCount === 0 });
});

auth.post('/signup', async (c) => {
  const signupThrottled = await enforceNamedThrottle(c, 'signup_attempts', clientIp(c), { windowSeconds: 3600, max: 5 }, ERROR_CODES.SIGNUP_THROTTLED);
  if (signupThrottled) return signupThrottled;
  const form = await body(c);
  if (!(await getSetting('auth.signup_enabled', true))) return c.json({ error: 'Signup is currently disabled' }, 403);
  if (!csrfOk(c, form)) return c.json({ error: 'Invalid CSRF token' }, 403);
  const parsed = z.object({ username: usernameSchema, email: emailSchema, password: passwordSchema, recoveryPin: pinSchema }).safeParse(form);
  if (!parsed.success) return c.json({ error: 'Invalid sign up details', details: parsed.error.flatten().fieldErrors }, 400);
  const passwordHash = await hashSecret(parsed.data.password);
  const pinHash = await hashSecret(parsed.data.recoveryPin);
  try {
    const result = await query(
      `insert into users (username, email, password_hash, recovery_pin_hash) values ($1, $2, $3, $4) returning id, username, email, role, status, created_at`,
      [parsed.data.username, parsed.data.email, passwordHash, pinHash]
    );
    await query('insert into recovery_pins (user_id, pin_hash) values ($1, $2)', [result.rows[0].id, pinHash]);
    await ensureCreditBalance(result.rows[0].id);
    const startingCredits = Number(await getSetting('credits.default_starting_credits', 0));
    if (startingCredits > 0) await adjustCredits({ userId: result.rows[0].id, amount: startingCredits, description: 'Starting credits', createdBy: result.rows[0].id });
    const key = await ensureUserApiKey(result.rows[0].id);
    await createSession(c, result.rows[0]);
    if (wantsHtml(c)) return c.html(`<div class="container py-5"><div class="alert alert-warning"><h1 class="h4">Your API key</h1><p>Store this API key now. It will only be shown once.</p><code>${key.rawKey}</code></div><a href="/dashboard">Continue to dashboard</a></div>`, 201);
    return c.json({ user: result.rows[0], apiKey: key.rawKey, message: 'Store this API key now. It will only be shown once.' }, 201);
  } catch (error) {
    if (error.code === '23505') return c.json({ error: 'Username or email is already in use' }, 409);
    throw error;
  }
});

auth.post('/login', async (c) => {
  const form = await body(c);
  const identity = `${clientIp(c)}:${String(form?.email || 'unknown').toLowerCase()}`;
  const loginThrottled = await enforceNamedThrottle(c, 'login_attempts', identity, { windowSeconds: 300, max: 10 }, ERROR_CODES.LOGIN_THROTTLED);
  if (loginThrottled) return loginThrottled;
  if (!csrfOk(c, form)) return fail(c, 'Invalid CSRF token', 403);
  const parsed = z.object({ email: emailSchema, password: passwordSchema }).safeParse(form);
  if (!parsed.success) return fail(c, 'Invalid email or password', 400);
  const result = await query('select id, username, email, password_hash, role, status, created_at from users where email = $1', [parsed.data.email]);
  const user = result.rows[0];
  if (!user || !(await verifySecret(user.password_hash, parsed.data.password))) {
    await logSuspiciousUsage({ c, userId: user?.id || null, reason: 'login_failed', severity: 'medium', metadata: { email: parsed.data.email } });
    return fail(c, 'Invalid email or password', 401, 'INVALID_CREDENTIALS');
  }
  if (user.status === 'suspended') return fail(c, 'Account suspended', 403);
  await ensureCreditBalance(user.id);
  await ensureUserApiKey(user.id);
  await createSession(c, user);
  const safeUser = { id: user.id, username: user.username, email: user.email, role: user.role, status: user.status, created_at: user.created_at };
  if (wantsHtml(c)) return c.redirect('/dashboard', 303);
  return c.json({ user: safeUser });
});


auth.post('/password-recovery/request', async (c) => {
  const form = await body(c);
  const identityForThrottle = `${clientIp(c)}:${String(form?.identity || 'unknown').toLowerCase()}`;
  const throttled = await enforceNamedThrottle(c, 'password_recovery_requests', identityForThrottle, { windowSeconds: 900, max: 5 }, 'PASSWORD_RECOVERY_THROTTLED');
  if (throttled) return throttled;
  if (!csrfOk(c, form)) return recoveryFail(c, 'Invalid CSRF token', 403);
  const parsed = z.object({ identity: recoveryIdentitySchema }).safeParse(form);
  if (!parsed.success) return recoveryFail(c, 'Enter your email address or username');
  const result = await query(`select id, username, email, status from users where lower(email::text) = lower($1) or lower(username::text) = lower($1) limit 1`, [parsed.data.identity]);
  const user = result.rows[0];
  if (!user || user.status !== 'active') {
    await logRecoveryEvent(c, { action: 'password_recovery_request_unknown', metadata: { identity: parsed.data.identity } });
    if (wantsHtml(c)) return c.redirect('/verify-recovery-pin', 303);
    return c.json({ ok: true, message: 'If the account exists, continue with your recovery PIN.' });
  }
  await logRecoveryEvent(c, { userId: user.id, action: 'password_recovery_requested' });
  if (wantsHtml(c)) return c.redirect(`/verify-recovery-pin?identity=${encodeURIComponent(parsed.data.identity)}`, 303);
  return c.json({ ok: true, message: 'Continue with your recovery PIN.' });
});

auth.post('/password-recovery/verify-pin', async (c) => {
  const form = await body(c);
  const identityForThrottle = `${clientIp(c)}:${String(form?.identity || 'unknown').toLowerCase()}`;
  const throttled = await enforceNamedThrottle(c, 'password_recovery_pin_attempts', identityForThrottle, { windowSeconds: 900, max: 10 }, 'PASSWORD_RECOVERY_THROTTLED');
  if (throttled) return throttled;
  if (!csrfOk(c, form)) return recoveryFail(c, 'Invalid CSRF token', 403);
  const parsed = z.object({ identity: recoveryIdentitySchema, recoveryPin: pinSchema }).safeParse(form);
  if (!parsed.success) return recoveryFail(c, 'Enter your account and recovery PIN');
  const result = await query(`select u.id, u.username, u.email, u.status, coalesce(r.pin_hash, u.recovery_pin_hash) pin_hash from users u left join recovery_pins r on r.user_id = u.id and r.status = 'active' where lower(u.email::text) = lower($1) or lower(u.username::text) = lower($1) limit 1`, [parsed.data.identity]);
  const user = result.rows[0];
  if (!user || user.status !== 'active' || !user.pin_hash) {
    await logRecoveryEvent(c, { userId: user?.id || null, action: 'password_recovery_pin_failed', metadata: { reason: 'account_not_found_or_inactive' } });
    return recoveryFail(c, 'Invalid account or recovery PIN', 401);
  }
  const lockTtl = await redis.ttl(recoveryLockKey(user.id));
  if (lockTtl > 0) {
    await logRecoveryEvent(c, { userId: user.id, action: 'password_recovery_locked', metadata: { resetSeconds: lockTtl } });
    if (wantsHtml(c)) return c.redirect(`/verify-recovery-pin?identity=${encodeURIComponent(parsed.data.identity)}&error=${encodeURIComponent(`Too many failed PIN attempts. Try again in ${Math.ceil(lockTtl / 60)} minutes.`)}`, 303);
    return c.json(errorPayload('PASSWORD_RECOVERY_LOCKED', 'Too many failed PIN attempts. Try again later.', c.get('requestId'), { resetSeconds: lockTtl }), 423);
  }
  if (!(await verifySecret(user.pin_hash, parsed.data.recoveryPin))) {
    const failures = await redis.incr(recoveryFailKey(user.id));
    if (failures === 1) await redis.expire(recoveryFailKey(user.id), RECOVERY_LOCK_SECONDS);
    await query(`update recovery_pins set failed_attempts = failed_attempts + 1 where user_id = $1 and status = 'active'`, [user.id]);
    if (failures >= RECOVERY_MAX_FAILED_PIN_ATTEMPTS) await redis.set(recoveryLockKey(user.id), '1', 'EX', RECOVERY_LOCK_SECONDS);
    await logRecoveryEvent(c, { userId: user.id, action: failures >= RECOVERY_MAX_FAILED_PIN_ATTEMPTS ? 'password_recovery_locked' : 'password_recovery_pin_failed', metadata: { failures } });
    return recoveryFail(c, 'Invalid account or recovery PIN', 401);
  }
  await redis.del(recoveryFailKey(user.id));
  await query(`update recovery_pins set failed_attempts = 0, last_used_at = now() where user_id = $1 and status = 'active'`, [user.id]);
  const resetSession = await createRecoverySession(user.id);
  await logRecoveryEvent(c, { userId: user.id, action: 'password_recovery_pin_verified' });
  if (wantsHtml(c)) return c.redirect(`/set-new-password?resetSession=${encodeURIComponent(resetSession)}`, 303);
  return c.json({ resetSession, expiresInSeconds: RECOVERY_SESSION_TTL_SECONDS });
});

auth.post('/password-recovery/reset', async (c) => {
  const form = await body(c);
  if (!csrfOk(c, form)) return recoveryFail(c, 'Invalid CSRF token', 403);
  const parsed = z.object({ resetSession: resetSessionSchema, password: passwordSchema }).safeParse(form);
  if (!parsed.success) return recoveryFail(c, 'Enter a valid new password');
  const session = await loadRecoverySession(parsed.data.resetSession);
  if (!session?.userId) return recoveryFail(c, 'Recovery session expired. Start again.', 401);
  await query('update users set password_hash = $2 where id = $1', [session.userId, await hashSecret(parsed.data.password)]);
  await redis.del(recoverySessionKey(parsed.data.resetSession));
  await logRecoveryEvent(c, { userId: session.userId, action: 'password_recovery_password_reset' });
  if (wantsHtml(c)) return c.redirect('/recovery-success', 303);
  return c.json({ ok: true });
});

auth.post('/logout', async (c) => {
  const form = await body(c).catch(() => ({}));
  const session = c.get('session');
  if (session && !csrfOk(c, form)) return c.json({ error: 'Invalid CSRF token' }, 403);
  await destroySession(c);
  if (wantsHtml(c)) return c.redirect('/login', 303);
  return c.json({ ok: true });
});
