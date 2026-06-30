-- Logging and analytics additions for proxy request dashboards.
alter table api_usage_logs add column if not exists request_ip inet;

create index if not exists api_usage_logs_created_idx on api_usage_logs(created_at desc);
create index if not exists api_usage_logs_user_status_created_idx on api_usage_logs(user_id, response_status, created_at desc) where user_id is not null;
create index if not exists api_usage_logs_request_ip_created_idx on api_usage_logs(request_ip, created_at desc) where request_ip is not null;
