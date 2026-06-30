insert into admin_settings (key, value, description) values
('site.name', '"QuickRest"'::jsonb, 'Displayed product name.'),
('site.public_base_url', '"http://localhost:3000"'::jsonb, 'Canonical public application URL.'),
('proxy.api_base_url', '"http://localhost:3000/api"'::jsonb, 'Base URL shown to API customers.'),
('billing.stripe_public_key_configured', 'false'::jsonb, 'Public Stripe configuration status.'),
('billing.stripe_secret_configured', 'false'::jsonb, 'Secret Stripe configuration status.'),
('credits.default_starting_credits', '0'::jsonb, 'Credits granted to new users.'),
('security.domain_allowlist_behavior', '"enforce"'::jsonb, 'How customer domain allowlists are enforced.'),
('security.api_key_rotation_rules', '{"max_age_days":90,"notify_before_days":14,"require_rotation":false}'::jsonb, 'API key rotation policy.'),
('platform.maintenance_mode', 'false'::jsonb, 'Temporarily block non-admin traffic.'),
('platform.maintenance_message', '"QuickRest is temporarily down for maintenance. Please try again shortly."'::jsonb, 'Message shown during maintenance.'),
('auth.signup_enabled', 'true'::jsonb, 'Allow new user registration.'),
('limits.global_requests', '{"window_seconds":60,"max_requests":120}'::jsonb, 'Default IP request rate limit.'),
('limits.per_user_requests', '{"window_seconds":60,"max_requests":600}'::jsonb, 'Per-user API request rate limit placeholder.'),
('webhooks.retry_settings', '{"max_attempts":5,"backoff_seconds":[30,120,600]}'::jsonb, 'Webhook retry policy.'),
('email.settings', '{"provider":"","from_email":"","reply_to":"","enabled":false}'::jsonb, 'Email integration placeholders.'),
('admin.notifications', '{"emails":[],"slack_webhook_configured":false,"notify_on_errors":true}'::jsonb, 'Admin alert placeholders.')
on conflict (key) do nothing;
