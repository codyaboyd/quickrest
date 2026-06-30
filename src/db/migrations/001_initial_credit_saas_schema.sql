-- QuickRest credit SaaS schema
create extension if not exists pgcrypto;
create extension if not exists citext;

create table if not exists schema_migrations (
  version text primary key,
  name text not null,
  applied_at timestamptz not null default now()
);

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  username citext not null unique,
  email citext not null unique,
  password_hash text not null,
  recovery_pin_hash text,
  role text not null default 'user' check (role in ('user', 'admin')),
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (length(trim(username::text)) between 3 and 64),
  check (position('@' in email::text) > 1),
  check (length(password_hash) >= 32),
  check (recovery_pin_hash is null or length(recovery_pin_hash) >= 32)
);

drop trigger if exists users_set_updated_at on users;
create trigger users_set_updated_at before update on users for each row execute function set_updated_at();

create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  key_prefix text not null,
  key_hash text not null unique,
  status text not null default 'active' check (status in ('active', 'disabled', 'revoked')),
  scopes text[] not null default '{}',
  expires_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (length(trim(name)) between 1 and 120),
  check (length(key_prefix) between 6 and 32),
  check (length(key_hash) >= 32),
  check (expires_at is null or expires_at > created_at),
  check ((status = 'revoked' and revoked_at is not null) or (status <> 'revoked'))
);

create index if not exists api_keys_user_id_idx on api_keys(user_id);
create index if not exists api_keys_key_prefix_idx on api_keys(key_prefix);
create index if not exists api_keys_active_lookup_idx on api_keys(user_id, status) where status = 'active';
drop trigger if exists api_keys_set_updated_at on api_keys;
create trigger api_keys_set_updated_at before update on api_keys for each row execute function set_updated_at();

create table if not exists allowed_domains (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  domain text not null,
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, domain),
  check (domain = lower(domain)),
  check (domain ~ '^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$')
);

create index if not exists allowed_domains_user_id_idx on allowed_domains(user_id);
drop trigger if exists allowed_domains_set_updated_at on allowed_domains;
create trigger allowed_domains_set_updated_at before update on allowed_domains for each row execute function set_updated_at();

create table if not exists recovery_pins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  pin_hash text not null,
  status text not null default 'active' check (status in ('active', 'rotated', 'revoked')),
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (length(pin_hash) >= 32)
);

create unique index if not exists recovery_pins_one_active_per_user_idx on recovery_pins(user_id) where status = 'active';
create index if not exists recovery_pins_user_id_idx on recovery_pins(user_id);
drop trigger if exists recovery_pins_set_updated_at on recovery_pins;
create trigger recovery_pins_set_updated_at before update on recovery_pins for each row execute function set_updated_at();

create table if not exists proxy_endpoints (
  id uuid primary key default gen_random_uuid(),
  public_path text not null,
  target_url text not null,
  http_method text not null check (http_method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS')),
  is_enabled boolean not null default true,
  auth_forwarding text not null default 'none' check (auth_forwarding in ('none', 'api_key', 'authorization_header', 'all_headers')),
  forward_api_key boolean not null default false,
  forward_authorization_header boolean not null default false,
  headers_config jsonb not null default '{}'::jsonb,
  timeout_ms integer not null default 30000 check (timeout_ms between 100 and 300000),
  credit_cost integer not null default 1 check (credit_cost >= 0),
  description text,
  admin_notes text,
  created_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (public_path, http_method),
  check (public_path ~ '^/[A-Za-z0-9._~!$&''()*+,;=:@%/-]*$'),
  check (target_url ~* '^https?://'),
  check (jsonb_typeof(headers_config) = 'object')
);

create index if not exists proxy_endpoints_enabled_idx on proxy_endpoints(is_enabled);
create index if not exists proxy_endpoints_path_method_idx on proxy_endpoints(public_path, http_method);
drop trigger if exists proxy_endpoints_set_updated_at on proxy_endpoints;
create trigger proxy_endpoints_set_updated_at before update on proxy_endpoints for each row execute function set_updated_at();

create table if not exists endpoint_credit_rules (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references proxy_endpoints(id) on delete cascade,
  rule_name text not null,
  priority integer not null default 100 check (priority >= 0),
  match_config jsonb not null default '{}'::jsonb,
  credit_cost integer not null check (credit_cost >= 0),
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (endpoint_id, rule_name),
  check (jsonb_typeof(match_config) = 'object')
);

create index if not exists endpoint_credit_rules_endpoint_priority_idx on endpoint_credit_rules(endpoint_id, is_enabled, priority);
drop trigger if exists endpoint_credit_rules_set_updated_at on endpoint_credit_rules;
create trigger endpoint_credit_rules_set_updated_at before update on endpoint_credit_rules for each row execute function set_updated_at();

create table if not exists credit_balances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  currency text not null default 'credits',
  balance integer not null default 0 check (balance >= 0),
  lifetime_purchased integer not null default 0 check (lifetime_purchased >= 0),
  lifetime_used integer not null default 0 check (lifetime_used >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, currency),
  check (currency ~ '^[a-z][a-z0-9_-]{2,31}$')
);

drop trigger if exists credit_balances_set_updated_at on credit_balances;
create trigger credit_balances_set_updated_at before update on credit_balances for each row execute function set_updated_at();

create table if not exists credit_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  balance_id uuid references credit_balances(id) on delete set null,
  api_key_id uuid references api_keys(id) on delete set null,
  endpoint_id uuid references proxy_endpoints(id) on delete set null,
  transaction_type text not null check (transaction_type in ('purchase', 'usage', 'refund', 'adjustment', 'admin_grant')),
  amount integer not null check (amount <> 0),
  balance_after integer check (balance_after >= 0),
  stripe_reference text,
  idempotency_key text,
  request_id text,
  metadata jsonb not null default '{}'::jsonb,
  description text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  check ((transaction_type = 'usage' and amount < 0 and endpoint_id is not null) or transaction_type <> 'usage'),
  check ((transaction_type in ('purchase', 'refund', 'admin_grant') and amount > 0) or transaction_type not in ('purchase', 'refund', 'admin_grant')),
  check (jsonb_typeof(metadata) = 'object')
);

create unique index if not exists credit_transactions_idempotency_key_idx on credit_transactions(idempotency_key) where idempotency_key is not null;
create index if not exists credit_transactions_user_created_idx on credit_transactions(user_id, created_at desc);
create index if not exists credit_transactions_endpoint_idx on credit_transactions(endpoint_id) where endpoint_id is not null;
create index if not exists credit_transactions_stripe_reference_idx on credit_transactions(stripe_reference) where stripe_reference is not null;
create index if not exists credit_transactions_type_idx on credit_transactions(transaction_type);

create table if not exists stripe_customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users(id) on delete cascade,
  stripe_customer_id text not null unique,
  email citext,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (stripe_customer_id like 'cus_%'),
  check (jsonb_typeof(metadata) = 'object')
);

drop trigger if exists stripe_customers_set_updated_at on stripe_customers;
create trigger stripe_customers_set_updated_at before update on stripe_customers for each row execute function set_updated_at();

create table if not exists stripe_checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  stripe_customer_id uuid references stripe_customers(id) on delete set null,
  stripe_session_id text not null unique,
  status text not null check (status in ('open', 'complete', 'expired', 'canceled')),
  credits integer not null check (credits > 0),
  amount_total_cents integer not null check (amount_total_cents >= 0),
  currency text not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  success_url text,
  cancel_url text,
  expires_at timestamptz,
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (stripe_session_id like 'cs_%'),
  check (jsonb_typeof(metadata) = 'object')
);

create index if not exists stripe_checkout_sessions_user_idx on stripe_checkout_sessions(user_id, created_at desc);
create index if not exists stripe_checkout_sessions_status_idx on stripe_checkout_sessions(status);
drop trigger if exists stripe_checkout_sessions_set_updated_at on stripe_checkout_sessions;
create trigger stripe_checkout_sessions_set_updated_at before update on stripe_checkout_sessions for each row execute function set_updated_at();

create table if not exists stripe_webhook_events (
  id uuid primary key default gen_random_uuid(),
  stripe_event_id text not null unique,
  event_type text not null,
  payload jsonb not null,
  processing_status text not null default 'pending' check (processing_status in ('pending', 'processed', 'failed', 'ignored')),
  processed_at timestamptz,
  error_message text,
  retry_count integer not null default 0 check (retry_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (stripe_event_id like 'evt_%'),
  check (jsonb_typeof(payload) = 'object')
);

create index if not exists stripe_webhook_events_status_idx on stripe_webhook_events(processing_status, created_at);
create index if not exists stripe_webhook_events_type_idx on stripe_webhook_events(event_type);
drop trigger if exists stripe_webhook_events_set_updated_at on stripe_webhook_events;
create trigger stripe_webhook_events_set_updated_at before update on stripe_webhook_events for each row execute function set_updated_at();

create table if not exists admin_settings (
  key text primary key,
  value jsonb not null,
  description text,
  is_secret boolean not null default false,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (key ~ '^[a-z][a-z0-9_.-]{1,127}$')
);

drop trigger if exists admin_settings_set_updated_at on admin_settings;
create trigger admin_settings_set_updated_at before update on admin_settings for each row execute function set_updated_at();

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references users(id) on delete set null,
  target_user_id uuid references users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  ip_address inet,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (length(action) between 1 and 120),
  check (length(entity_type) between 1 and 120),
  check (jsonb_typeof(metadata) = 'object')
);

create index if not exists audit_logs_actor_created_idx on audit_logs(actor_user_id, created_at desc);
create index if not exists audit_logs_entity_idx on audit_logs(entity_type, entity_id);
create index if not exists audit_logs_target_user_idx on audit_logs(target_user_id, created_at desc);

create table if not exists password_reset_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending', 'used', 'expired', 'revoked')),
  requested_ip inet,
  requested_user_agent text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (length(token_hash) >= 32),
  check (expires_at > created_at),
  check ((status = 'used' and used_at is not null) or status <> 'used')
);

create index if not exists password_reset_events_user_created_idx on password_reset_events(user_id, created_at desc);
create index if not exists password_reset_events_pending_idx on password_reset_events(user_id, expires_at) where status = 'pending';
drop trigger if exists password_reset_events_set_updated_at on password_reset_events;
create trigger password_reset_events_set_updated_at before update on password_reset_events for each row execute function set_updated_at();
