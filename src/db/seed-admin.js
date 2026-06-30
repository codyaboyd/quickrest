import 'dotenv/config';
import { query, pool } from './postgres.js';
import argon2 from 'argon2';

async function hashSecret(secret) {
  return argon2.hash(secret, { type: argon2.argon2id, memoryCost: 19456, timeCost: 3, parallelism: 1 });
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required`);
    process.exitCode = 1;
    return '';
  }
  return value;
}

const username = process.env.ADMIN_USERNAME?.trim() || 'admin';
const email = required('ADMIN_EMAIL').toLowerCase();
const password = required('ADMIN_PASSWORD');
const recoveryPin = required('ADMIN_RECOVERY_PIN');

if (password.length < 12) {
  console.error('ADMIN_PASSWORD must be at least 12 characters for production seeding');
  process.exit(1);
}

try {
  const passwordHash = await hashSecret(password);
  const recoveryPinHash = await hashSecret(recoveryPin);
  const result = await query(
    `insert into users (username, email, password_hash, recovery_pin_hash, role, status)
     values ($1, $2, $3, $4, 'admin', 'active')
     on conflict (email) do update set
       username = excluded.username,
       password_hash = excluded.password_hash,
       recovery_pin_hash = excluded.recovery_pin_hash,
       role = 'admin',
       status = 'active',
       updated_at = now()
     returning id, username, email, role, status`,
    [username, email, passwordHash, recoveryPinHash]
  );

  const admin = result.rows[0];
  console.log(`Seeded admin user ${admin.email} (${admin.id}) with role ${admin.role}`);
} catch (error) {
  console.error('Failed to seed admin user');
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
