import pg from 'pg';
import { env } from '../config/env.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});

export async function query(text, params = []) {
  return pool.query(text, params);
}

export async function checkPostgres() {
  const result = await query('select now() as now');
  return result.rows[0]?.now instanceof Date || Boolean(result.rows[0]?.now);
}
