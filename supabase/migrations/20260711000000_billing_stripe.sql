-- Migration date: 2026-07-01
--
-- Renumbered to run after the latest existing migration
-- (20260701000004_dms_connectors.sql). It is purely additive and guarded, so
-- ordering after the org-RBAC / DMS migrations is safe; the original
-- 2026-06-29 authoring date collided with a later platform migration's version.
--
-- Stripe billing & usage metering (see docs/adr/0002-stripe-billing.md).
--
-- WHAT THIS ADDS:
--   1. Subscription columns on user_profiles linking a Mike user to their
--      Stripe customer + subscription, and caching the subscription status and
--      current period end so the billing UI and credit checks don't have to
--      call Stripe on every request.
--   2. A billing_events ledger that gives the webhook handler idempotency:
--      Stripe delivers events at-least-once and retries on timeout, so the same
--      event id can arrive twice. Recording processed ids and skipping repeats
--      keeps payment side effects (e.g. resetting credits on renewal) safe to
--      replay.
--
-- Safe to re-run: every statement is guarded (IF NOT EXISTS).

-- ---------------------------------------------------------------------------
-- user_profiles: Stripe subscription linkage
-- ---------------------------------------------------------------------------

alter table public.user_profiles
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists subscription_status text,
  add column if not exists subscription_current_period_end timestamptz;

-- One Stripe customer maps to at most one user.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_profiles_stripe_customer_id_key'
      and conrelid = 'public.user_profiles'::regclass
  ) then
    alter table public.user_profiles
      add constraint user_profiles_stripe_customer_id_key
      unique (stripe_customer_id);
  end if;
end;
$$;

create index if not exists idx_user_profiles_stripe_customer
  on public.user_profiles(stripe_customer_id);

-- ---------------------------------------------------------------------------
-- billing_events: webhook idempotency ledger
-- ---------------------------------------------------------------------------

create table if not exists public.billing_events (
  event_id text primary key,
  type text not null,
  received_at timestamptz not null default now()
);

-- Billing data is backend-only. Enable RLS and revoke direct client grants,
-- following the deny-all convention in 20260524000000_rls_deny_all.sql. With
-- RLS on and no policy, anon/authenticated rows resolve to "no access"; the
-- service-role key the API uses bypasses RLS.
alter table public.billing_events enable row level security;
revoke all on public.billing_events from anon, authenticated;
