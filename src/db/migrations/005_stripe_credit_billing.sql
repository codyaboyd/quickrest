-- Stripe Checkout credit billing.

create table if not exists credit_packages (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  credits integer not null check (credits > 0),
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  is_active boolean not null default true,
  sort_order integer not null default 100,
  created_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (name),
  check (length(trim(name)) between 1 and 120)
);

create index if not exists credit_packages_active_sort_idx on credit_packages(is_active, sort_order, amount_cents);
drop trigger if exists credit_packages_set_updated_at on credit_packages;
create trigger credit_packages_set_updated_at before update on credit_packages for each row execute function set_updated_at();

insert into credit_packages (name, credits, amount_cents, currency, sort_order)
values
  ('$10 Starter', 1000, 1000, 'usd', 10),
  ('$25 Growth', 3000, 2500, 'usd', 20),
  ('$100 Scale', 15000, 10000, 'usd', 30)
on conflict (name) do nothing;

alter table stripe_checkout_sessions add column if not exists credit_package_id uuid references credit_packages(id) on delete set null;
alter table stripe_checkout_sessions add column if not exists payment_status text not null default 'unpaid' check (payment_status in ('unpaid', 'paid', 'no_payment_required', 'failed', 'refunded'));
alter table stripe_checkout_sessions add column if not exists payment_intent_id text;
alter table stripe_checkout_sessions add column if not exists refunded_at timestamptz;
alter table stripe_checkout_sessions add column if not exists failure_message text;

alter table stripe_checkout_sessions drop constraint if exists stripe_checkout_sessions_status_check;
alter table stripe_checkout_sessions add constraint stripe_checkout_sessions_status_check check (status in ('open', 'complete', 'expired', 'canceled', 'failed', 'refunded'));

create index if not exists stripe_checkout_sessions_package_idx on stripe_checkout_sessions(credit_package_id) where credit_package_id is not null;
create index if not exists stripe_checkout_sessions_payment_intent_idx on stripe_checkout_sessions(payment_intent_id) where payment_intent_id is not null;

alter table stripe_webhook_events add column if not exists stripe_checkout_session_id uuid references stripe_checkout_sessions(id) on delete set null;

alter table credit_transactions drop constraint if exists credit_transactions_amount_direction_check;
alter table credit_transactions add constraint credit_transactions_amount_direction_check check (
  (transaction_type = 'endpoint_usage' and amount < 0 and endpoint_id is not null) or
  (transaction_type in ('purchase', 'failed_usage_refund') and amount > 0) or
  (transaction_type in ('admin_adjustment', 'refund'))
);
