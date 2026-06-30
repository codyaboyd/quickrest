create table if not exists suspicious_usage_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  api_key_id uuid references api_keys(id) on delete set null,
  endpoint_id uuid references proxy_endpoints(id) on delete set null,
  ip_address inet,
  user_agent text,
  request_path text not null,
  reason text not null,
  severity text not null default 'low' check (severity in ('low', 'medium', 'high', 'critical')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(metadata) = 'object')
);

create index if not exists suspicious_usage_logs_created_idx on suspicious_usage_logs(created_at desc);
create index if not exists suspicious_usage_logs_user_idx on suspicious_usage_logs(user_id, created_at desc) where user_id is not null;
create index if not exists suspicious_usage_logs_reason_idx on suspicious_usage_logs(reason, created_at desc);

create table if not exists api_ip_access_rules (
  id uuid primary key default gen_random_uuid(),
  list_type text not null check (list_type in ('allow', 'block')),
  ip_address inet,
  cidr cidr,
  reason text,
  is_enabled boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((ip_address is not null and cidr is null) or (ip_address is null and cidr is not null))
);

create index if not exists api_ip_access_rules_type_enabled_idx on api_ip_access_rules(list_type, is_enabled);
drop trigger if exists api_ip_access_rules_set_updated_at on api_ip_access_rules;
create trigger api_ip_access_rules_set_updated_at before update on api_ip_access_rules for each row execute function set_updated_at();
