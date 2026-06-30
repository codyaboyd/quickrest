alter table users add column if not exists wildcard_domains_enabled boolean not null default false;

create table if not exists api_usage_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  api_key_id uuid references api_keys(id) on delete set null,
  service_slug text,
  request_method text not null,
  request_path text not null,
  request_domain text,
  response_status integer,
  credits_charged integer not null default 0 check (credits_charged >= 0),
  auth_success boolean not null default true,
  failure_reason text,
  created_at timestamptz not null default now()
);

create index if not exists api_usage_logs_user_created_idx on api_usage_logs(user_id, created_at desc);
create index if not exists api_usage_logs_api_key_created_idx on api_usage_logs(api_key_id, created_at desc);
create index if not exists api_usage_logs_auth_success_idx on api_usage_logs(auth_success, created_at desc);
