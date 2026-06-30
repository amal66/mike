-- Developer platform: programmatic API keys + webhooks.
--
-- WHY THIS EXISTS:
-- The SDKs previously authenticated only with a short-lived Supabase JWT — fine
-- for a browser, useless for a script, cron job, or CI pipeline. This migration
-- adds the storage for two new capabilities:
--   1. api_keys           — long-lived programmatic credentials.
--   2. webhook_endpoints  — where to push events, + the HMAC signing secret.
--      webhook_deliveries — the recorded history/result of every send.
--
-- SECURITY NOTES baked into the schema:
--   - We store only a SHA-256 *hash* of each API key (key_hash), never the
--     secret. A DB leak therefore can't be replayed against the API. A short,
--     non-secret key_prefix is stored in the clear purely for display + lookup.
--   - Every table gets RLS enabled with a deny-all policy and has direct
--     privileges revoked from anon/authenticated. All access goes through the
--     backend service role — consistent with the rest of this schema (see
--     20260524000000_rls_deny_all.sql).

-- ── api_keys ────────────────────────────────────────────────────────────────
create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  key_prefix text not null,
  key_hash text not null unique,
  scopes text[] not null default array['read','write'],
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- Partial index: authentication looks keys up by prefix, and only live keys
-- (revoked_at is null) are ever candidates, so the index stays small + fast.
create index if not exists idx_api_keys_prefix_active
  on public.api_keys(key_prefix)
  where revoked_at is null;
create index if not exists idx_api_keys_user
  on public.api_keys(user_id);

-- ── webhook_endpoints ────────────────────────────────────────────────────────
create table if not exists public.webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  url text not null,
  secret text not null,
  enabled boolean not null default true,
  event_types text[] not null default array[]::text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_webhook_endpoints_user
  on public.webhook_endpoints(user_id);

-- ── webhook_deliveries ───────────────────────────────────────────────────────
create table if not exists public.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint_id uuid not null references public.webhook_endpoints(id) on delete cascade,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'succeeded', 'failed')),
  attempts integer not null default 0,
  response_status integer,
  response_body text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  delivered_at timestamptz
);

create index if not exists idx_webhook_deliveries_endpoint
  on public.webhook_deliveries(endpoint_id, created_at desc);
create index if not exists idx_webhook_deliveries_user
  on public.webhook_deliveries(user_id, created_at desc);

-- ── RLS: enable + deny-all (matches the repo's default-deny posture) ─────────
alter table public.api_keys enable row level security;
alter table public.webhook_endpoints enable row level security;
alter table public.webhook_deliveries enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['api_keys', 'webhook_endpoints', 'webhook_deliveries']
  loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t
    ) then
      execute format(
        'create policy deny_all_fallback on public.%I
           for all to anon, authenticated
           using (false) with check (false)',
        t
      );
    end if;
  end loop;
end
$$;

-- Backend service role only — no direct client access.
revoke all on public.api_keys from anon, authenticated;
revoke all on public.webhook_endpoints from anon, authenticated;
revoke all on public.webhook_deliveries from anon, authenticated;
