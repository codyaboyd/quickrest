alter table proxy_endpoints add column if not exists deduct_credits_on_failure boolean not null default false;

alter table api_usage_logs add column if not exists endpoint_id uuid references proxy_endpoints(id) on delete set null;
alter table api_usage_logs add column if not exists duration_ms integer check (duration_ms is null or duration_ms >= 0);

create index if not exists api_usage_logs_endpoint_created_idx on api_usage_logs(endpoint_id, created_at desc) where endpoint_id is not null;

insert into admin_settings (key, value, description)
values ('proxy.allow_internal_targets', 'false'::jsonb, 'Allow proxy endpoints to target localhost or private network addresses. Disabled by default for SSRF protection.')
on conflict (key) do nothing;
