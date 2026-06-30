import { Hono } from 'hono';
import { z } from 'zod';
import { getCookie } from 'hono/cookie';
import { query } from '../db/postgres.js';
import { CSRF_COOKIE, createSession, destroySession, hashSecret, verifySecret } from '../services/authService.js';
import { ensureUserApiKey } from '../services/apiKeyService.js';
import { ensureCreditBalance, adjustCredits } from '../services/creditService.js';
import { getSetting } from '../services/adminSettingsService.js';
import { ERROR_CODES, clientIp, enforceNamedThrottle, errorPayload, logSuspiciousUsage } from '../services/apiProtectionService.js';

export const auth = new Hono();

const usernameSchema = z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9_-]+$/, 'Use letters, numbers, underscores, or hyphens');
const emailSchema = z.string().trim().email().max(254).toLowerCase();
const passwordSchema = z.string().min(8).max(256);
const pinSchema = z.string().trim().regex(/^\d{4,12}$/, 'Use a 4-12 digit recovery PIN');

function csrfOk(c, body) {
  const cookieToken = getCookie(c, CSRF_COOKIE);
  const token = c.req.header('x-csrf-token') || body?.csrfToken;
  return Boolean(cookieToken && token && cookieToken === token);
}

function wantsHtml(c) {
  return c.req.header('accept')?.includes('text/html');
}

async function body(c) {
  const type = c.req.header('content-type') || '';
  return type.includes('application/json') ? await c.req.json() : await c.req.parseBody();
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

auth.post('/logout', async (c) => {
  const form = await body(c).catch(() => ({}));
  const session = c.get('session');
  if (session && !csrfOk(c, form)) return c.json({ error: 'Invalid CSRF token' }, 403);
  await destroySession(c);
  if (wantsHtml(c)) return c.redirect('/login', 303);
  return c.json({ ok: true });
});
