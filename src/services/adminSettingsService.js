import { env } from '../config/env.js';
import { query } from '../db/postgres.js';

export const SETTING_DEFINITIONS = [
  { key: 'site.name', label: 'Site name', type: 'text', defaultValue: env.APP_NAME, description: 'Displayed product name.' },
  { key: 'site.public_base_url', label: 'Public base URL', type: 'url', defaultValue: env.APP_URL, description: 'Canonical public application URL.' },
  { key: 'proxy.api_base_url', label: 'Proxy API base URL', type: 'url', defaultValue: `${env.APP_URL}/api`, description: 'Base URL shown to API customers.' },
  { key: 'billing.stripe_public_key_configured', label: 'Stripe public key configured', type: 'boolean', defaultValue: false, description: 'Public Stripe configuration status.' },
  { key: 'billing.stripe_secret_configured', label: 'Stripe secret key configured', type: 'boolean', defaultValue: Boolean(env.STRIPE_SECRET_KEY), description: 'Secret Stripe configuration status.' },
  { key: 'credits.default_starting_credits', label: 'Default user starting credits', type: 'number', defaultValue: 0, description: 'Credits granted to new users.' },
  { key: 'security.domain_allowlist_behavior', label: 'Domain allowlist behavior', type: 'select', options: ['enforce', 'allow_wildcard_per_user', 'disabled'], defaultValue: 'enforce', description: 'How customer domain allowlists are enforced.' },
  { key: 'security.api_key_rotation_rules', label: 'API key rotation rules', type: 'json', defaultValue: { max_age_days: 90, notify_before_days: 14, require_rotation: false }, description: 'API key rotation policy.' },
  { key: 'platform.maintenance_mode', label: 'Maintenance mode', type: 'boolean', defaultValue: false, description: 'Temporarily block non-admin traffic.' },
  { key: 'platform.maintenance_message', label: 'Maintenance message', type: 'textarea', defaultValue: 'QuickRest is temporarily down for maintenance. Please try again shortly.', description: 'Message shown during maintenance.' },
  { key: 'auth.signup_enabled', label: 'Signup enabled', type: 'boolean', defaultValue: true, description: 'Allow new user registration.' },
  { key: 'limits.global_requests', label: 'Global request rate limit', type: 'json', defaultValue: { window_seconds: env.RATE_LIMIT_WINDOW_SECONDS, max_requests: env.RATE_LIMIT_MAX_REQUESTS }, description: 'Default IP request rate limit.' },
  { key: 'limits.per_user_requests', label: 'Per-user request rate limit', type: 'json', defaultValue: { window_seconds: 60, max_requests: 600 }, description: 'Per-user API request rate limit placeholder.' },
  { key: 'proxy.allow_internal_targets', label: 'Internal target URLs allowed', type: 'boolean', defaultValue: false, description: 'Allow localhost/private-network upstream URLs.' },
  { key: 'webhooks.retry_settings', label: 'Webhook retry settings', type: 'json', defaultValue: { max_attempts: 5, backoff_seconds: [30, 120, 600] }, description: 'Webhook retry policy.' },
  { key: 'email.settings', label: 'Email settings placeholders', type: 'json', defaultValue: { provider: '', from_email: '', reply_to: '', enabled: false }, description: 'Email integration placeholders.' },
  { key: 'admin.notifications', label: 'Admin notification placeholders', type: 'json', defaultValue: { emails: [], slack_webhook_configured: false, notify_on_errors: true }, description: 'Admin alert placeholders.' }
];

export function definitionMap() { return new Map(SETTING_DEFINITIONS.map((definition) => [definition.key, definition])); }

export async function ensureAdminSettings() {
  for (const definition of SETTING_DEFINITIONS) {
    await query('insert into admin_settings (key, value, description) values ($1, $2::jsonb, $3) on conflict (key) do nothing', [definition.key, JSON.stringify(definition.defaultValue), definition.description]);
  }
}

export async function getAdminSettings() {
  await ensureAdminSettings();
  const rows = (await query('select * from admin_settings order by key')).rows;
  const values = new Map(rows.map((row) => [row.key, row]));
  return SETTING_DEFINITIONS.map((definition) => ({ ...definition, ...(values.get(definition.key) || {}), value: values.get(definition.key)?.value ?? definition.defaultValue }));
}

export async function getSetting(key, fallback) {
  const result = await query('select value from admin_settings where key = $1 limit 1', [key]);
  if (result.rowCount === 0) return fallback;
  return result.rows[0].value;
}

export async function updateSetting({ key, value, updatedBy, c }) {
  const previous = (await query('select value from admin_settings where key = $1', [key])).rows[0]?.value;
  const saved = await query('update admin_settings set value = $2::jsonb, updated_by = $3 where key = $1 returning *', [key, JSON.stringify(value), updatedBy]);
  await query(`insert into audit_logs (actor_user_id, action, entity_type, ip_address, user_agent, metadata) values ($1, 'admin_setting_updated', 'admin_setting', nullif($2, '')::inet, $3, $4::jsonb)`, [updatedBy, c?.req.header('x-forwarded-for')?.split(',')[0]?.trim() || '', c?.req.header('user-agent') || '', JSON.stringify({ key, previous, value })]);
  return saved.rows[0];
}
