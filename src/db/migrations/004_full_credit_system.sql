-- Full credit system: canonical transaction types, idempotent purchases, summaries, and safer balances.

insert into credit_balances (user_id, currency, balance)
select id, 'credits', 0 from users
on conflict (user_id, currency) do nothing;

do $$
declare constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'credit_transactions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%transaction_type%'
  loop
    execute format('alter table credit_transactions drop constraint if exists %I', constraint_name);
  end loop;
end $$;

update credit_transactions set transaction_type = 'endpoint_usage' where transaction_type = 'usage';
update credit_transactions set transaction_type = 'admin_adjustment' where transaction_type in ('adjustment', 'admin_grant');

alter table credit_transactions add constraint credit_transactions_transaction_type_check
  check (transaction_type in ('purchase', 'endpoint_usage', 'refund', 'admin_adjustment', 'failed_usage_refund'));

alter table credit_transactions add constraint credit_transactions_amount_direction_check check (
  (transaction_type = 'endpoint_usage' and amount < 0 and endpoint_id is not null) or
  (transaction_type in ('purchase', 'refund', 'failed_usage_refund') and amount > 0) or
  (transaction_type = 'admin_adjustment')
);

create unique index if not exists credit_transactions_stripe_reference_unique_idx
  on credit_transactions(stripe_reference) where stripe_reference is not null and transaction_type = 'purchase';

create index if not exists credit_transactions_user_type_created_idx on credit_transactions(user_id, transaction_type, created_at desc);
create index if not exists credit_transactions_created_idx on credit_transactions(created_at desc);

create or replace view credit_usage_summary_by_day as
select user_id, date_trunc('day', created_at)::date as usage_date, count(*)::int as request_count, abs(coalesce(sum(amount),0))::int as credits_used
from credit_transactions
where transaction_type = 'endpoint_usage'
group by user_id, date_trunc('day', created_at)::date;

create or replace view credit_usage_summary_by_endpoint as
select user_id, endpoint_id, count(*)::int as request_count, abs(coalesce(sum(amount),0))::int as credits_used
from credit_transactions
where transaction_type = 'endpoint_usage'
group by user_id, endpoint_id;

create or replace view credit_usage_summary_by_user as
select user_id, count(*)::int as request_count, abs(coalesce(sum(amount),0))::int as credits_used
from credit_transactions
where transaction_type = 'endpoint_usage'
group by user_id;
