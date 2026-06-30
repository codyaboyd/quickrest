import { pool, query } from './postgres.js';

const statements = [
  `create extension if not exists pgcrypto`,
  `create table if not exists tenants (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    slug text not null unique,
    credit_balance integer not null default 0 check (credit_balance >= 0),
    created_at timestamptz not null default now()
  )`,
  `create table if not exists api_services (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid references tenants(id) on delete cascade,
    name text not null,
    slug text not null,
    upstream_url text not null,
    credit_cost integer not null default 1 check (credit_cost > 0),
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    unique (tenant_id, slug)
  )`,
  `create table if not exists api_keys (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references tenants(id) on delete cascade,
    name text not null,
    key_prefix text not null,
    key_hash text not null unique,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    last_used_at timestamptz
  )`,
  `create table if not exists usage_events (
    id bigserial primary key,
    tenant_id uuid not null references tenants(id) on delete cascade,
    api_service_id uuid references api_services(id) on delete set null,
    credits_charged integer not null,
    status_code integer,
    path text not null,
    created_at timestamptz not null default now()
  )`
];

for (const statement of statements) {
  await query(statement);
}

console.log('Database migrations completed');
await pool.end();
