import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './postgres.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, 'migrations');

const migrationFiles = (await readdir(migrationsDir))
  .filter((file) => /^\d+_.+\.sql$/.test(file))
  .sort();

if (migrationFiles.length === 0) {
  console.log('No database migrations found');
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();

try {
  await client.query('begin');
  await client.query(`
    create table if not exists schema_migrations (
      version text primary key,
      name text not null,
      applied_at timestamptz not null default now()
    )
  `);

  const appliedResult = await client.query('select version from schema_migrations');
  const appliedVersions = new Set(appliedResult.rows.map((row) => row.version));

  let appliedCount = 0;

  for (const file of migrationFiles) {
    const [version, ...nameParts] = file.replace(/\.sql$/, '').split('_');
    const name = nameParts.join('_');

    if (appliedVersions.has(version)) {
      continue;
    }

    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    await client.query(sql);
    await client.query(
      'insert into schema_migrations (version, name) values ($1, $2)',
      [version, name]
    );
    appliedCount += 1;
    console.log(`Applied migration ${version}_${name}`);
  }

  await client.query('commit');
  console.log(`Database migrations completed (${appliedCount} applied)`);
} catch (error) {
  await client.query('rollback');
  console.error('Database migration failed');
  console.error(error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
