-- Migration date: 2026-08-27

-- Organizations, roles, invitations and role-aware project sharing.
--
-- The app has been per-user since the baseline: every data table carries a
-- `user_id` FK to auth.users and access is "row owner OR email in shared_with".
-- This migration introduces the tenant layer and the role model that goes with
-- it:
--
--   organizations       — a tenant (a firm). Nothing is auto-provisioned:
--                         personal content is simply `org_id is null`.
--   org_members         — (org_id, user_id, role) with role in admin/member.
--                         Written only by org creation and by invitation
--                         acceptance.
--   org_invitations     — pending, consent-based membership. A pending
--                         invitation grants NO access.
--   project_access_grants — direct sharing WITH A ROLE, superseding the
--                         roleless projects.shared_with array.
--
-- `org_id` is added to projects/documents/workflows/tabular_reviews as a
-- NULLABLE FK with ON DELETE SET NULL — nullable because personal content has
-- no org and system workflows have no user either.
--
-- The five tables that make up a project tree also have their `user_id`
-- relaxed to nullable ON DELETE SET NULL. An organization is the durable owner
-- of its projects: deleting the account that happened to create a matter must
-- not delete the firm's matter. backend/src/lib/userDataCleanup.ts detaches
-- that content (user_id -> null) instead of deleting it, and these FKs are
-- what let those rows survive the auth.users cascade that follows.
--
-- RLS: every new table gets `enable row level security` + an explicit revoke of
-- anon/authenticated, so direct client roles get nothing. The API runs with the
-- service key and enforces access in code, so it is unaffected.
--
-- SSO / SAML / SCIM: intentionally NOT implemented here. `organizations` is
-- shaped to grow future `sso_config` / `scim_token` columns; roles are text
-- CHECKs that can gain values without a table rewrite.
--
-- Does NOT edit any existing migration.

-- ---------------------------------------------------------------------------
-- Organizations / RBAC (multi-tenant)
-- See lib/access.ts for the admin/member enforcement.
--
-- Personal content is simply `org_id is null`. There is no hidden personal
-- organization: an extra org row and owner-membership per account bought
-- nothing that `user_id` did not already anchor, while making every query
-- carry a tenant that existed only to be ignored.
-- ---------------------------------------------------------------------------

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.organizations enable row level security;

-- Exactly two roles. `admin` administers the org and inherits project admin on
-- its projects; `member` collaborates and inherits project member. Membership
-- rows are written only by org creation (the creator) and by invitation
-- acceptance.
create table if not exists public.org_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member'
    check (role in ('admin', 'member')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(org_id, user_id)
);

create index if not exists idx_org_members_user on public.org_members(user_id);
create index if not exists idx_org_members_org on public.org_members(org_id);

alter table public.org_members enable row level security;

-- DB-level guard for "an organization must keep at least one admin". The
-- service layer checks this too, but its read-then-act check races: two
-- concurrent departures of two different admins can both pass and strand the
-- org with nobody able to invite, re-role or remove anyone. The trigger
-- serializes admin departures per org by locking the organizations row, and
-- steps aside for the two legitimate cascades: org deletion (the org row is
-- already gone in this transaction) and auth-user deletion (the member's auth
-- row is already gone). security definer so the auth.users probe works
-- regardless of the calling role, mirroring handle_new_user.
create or replace function public.org_members_protect_last_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.role <> 'admin' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.role = 'admin' then
    return new;
  end if;

  -- Serialize concurrent admin departures on this org. If the org row is
  -- already deleted in this transaction (delete cascade), stand aside.
  perform 1 from public.organizations where id = old.org_id for update;
  if not found then
    return coalesce(new, old);
  end if;

  -- Member's auth user being deleted (cascade from auth.users): stand aside.
  if tg_op = 'DELETE' and not exists (
    select 1 from auth.users where id = old.user_id
  ) then
    return old;
  end if;

  if not exists (
    select 1 from public.org_members
    where org_id = old.org_id and role = 'admin' and user_id <> old.user_id
  ) then
    raise exception 'An organization must keep at least one admin'
      using errcode = '23514';
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists org_members_last_admin_guard on public.org_members;
create trigger org_members_last_admin_guard
  before delete or update of role on public.org_members
  for each row execute procedure public.org_members_protect_last_admin();

-- Invitations. Joining a firm's workspace exposes confidential material, so
-- membership requires the recipient's consent: an admin creates a pending
-- invitation, and org_members only appears when the invited account accepts.
-- A pending invitation grants NOTHING on its own.
--
-- Addressed by normalized email rather than user id so an invitation can be
-- created before the recipient has an account and claimed after they sign up.
-- Expiry is evaluated lazily on read (a pending row past expires_at reports as
-- expired and cannot be accepted), so no sweeper job races the accept path.
create table if not exists public.org_invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  role text not null default 'member'
    check (role in ('admin', 'member')),
  invited_by uuid references auth.users(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  expires_at timestamptz not null default (now() + interval '14 days'),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  declined_at timestamptz,
  cancelled_at timestamptz,
  constraint org_invitations_email_lowercase check (email = lower(email))
);

-- One live invitation per (org, email); answered ones may accumulate.
create unique index if not exists org_invitations_active_unique
  on public.org_invitations(org_id, email)
  where status = 'pending';

create index if not exists idx_org_invitations_email
  on public.org_invitations(email) where status = 'pending';
create index if not exists idx_org_invitations_org
  on public.org_invitations(org_id);

alter table public.org_invitations enable row level security;

-- ---------------------------------------------------------------------------
-- org_id on the four content tables (nullable + FK + index)
-- ---------------------------------------------------------------------------

alter table public.projects
  add column if not exists org_id uuid references public.organizations(id) on delete set null;
alter table public.documents
  add column if not exists org_id uuid references public.organizations(id) on delete set null;
alter table public.workflows
  add column if not exists org_id uuid references public.organizations(id) on delete set null;
alter table public.tabular_reviews
  add column if not exists org_id uuid references public.organizations(id) on delete set null;

create index if not exists idx_projects_org on public.projects(org_id);
create index if not exists idx_documents_org on public.documents(org_id);
create index if not exists idx_workflows_org on public.workflows(org_id);
create index if not exists idx_tabular_reviews_org on public.tabular_reviews(org_id);

-- ---------------------------------------------------------------------------
-- Content ownership becomes nullable
-- ---------------------------------------------------------------------------
-- Each of these tables anchors a row to the account that created it with a
-- NOT NULL ON DELETE CASCADE FK. That is right for personal content and wrong
-- for an organization's: it makes the firm's matters hostage to one leaver's
-- account. Relax to nullable ON DELETE SET NULL so the rows can outlive their
-- author, and let userDataCleanup decide which ones actually should.
--
-- The list is every table that can hold content an organization owns:
--
--   projects, project_subfolders, documents, chats, tabular_reviews
--     — the project tree.
--   workflows
--     — org workflows carry `org_id` exactly like the four tables above; a
--       cascade here would delete the firm's shared workflows along with
--       whoever first drafted them.
--   tabular_review_chats
--     — hangs off a review that now survives its author. Cascading the
--       thread away while keeping the review it discusses loses the
--       reasoning and leaves the review looking like it was never worked on.
--   workflow_reference_documents
--     — hangs off a workflow, and its `workflow_id` FK already cascades from
--       `workflows`. Leaving `user_id` on cascade would strip an org
--       workflow of the very documents it references the moment its author
--       left, quietly breaking a workflow that otherwise survived intact.
--       (20260901_03 folds these into `documents`; on a database past that
--       point the table is gone and the loop skips it — the `documents`
--       conversion above already covers workflow assets there.)
--
-- Deliberately NOT in this list: per-account tables where the row IS the
-- account's own state and should die with it — user_api_keys, quick_actions,
-- hidden_workflows, default_workflow_installations, library_folders,
-- word_documents, word_chats, org_members, audit_events.
--
-- Re-runnable: dropping a constraint that is already gone is guarded, and
-- `drop not null` is idempotent by nature.

do $$
declare
  t text;
  c text;
begin
  foreach t in array array[
    'projects', 'project_subfolders', 'documents', 'chats', 'tabular_reviews',
    'workflows', 'tabular_review_chats', 'workflow_reference_documents'
  ] loop
    -- workflow_reference_documents no longer exists once
    -- 20260901_03_workflow_assets_as_documents has folded workflow assets
    -- into `documents` (whose user_id this same loop converts). Skip any
    -- table the running database does not have, so the loop is correct both
    -- before and after that migration.
    if to_regclass(format('public.%I', t)) is null then
      continue;
    end if;

    execute format('alter table public.%I alter column user_id drop not null', t);

    select con.conname into c
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    join pg_attribute att
      on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
    where nsp.nspname = 'public'
      and rel.relname = t
      and con.contype = 'f'
      and att.attname = 'user_id'
      and array_length(con.conkey, 1) = 1
      and con.confdeltype <> 'n'      -- 'n' = SET NULL: already converted
    limit 1;

    if c is not null then
      execute format('alter table public.%I drop constraint %I', t, c);
      execute format(
        'alter table public.%I add constraint %I foreign key (user_id) '
        'references auth.users(id) on delete set null', t, c);
    end if;
    c := null;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- project_access_grants — direct, role-aware sharing
-- ---------------------------------------------------------------------------
-- Supersedes the roleless projects.shared_with email array, which could say
-- WHO had access but never WHAT they could do: read-only outside counsel and
-- a colleague restructuring the matter were the same grant.
--
-- Keyed by normalized email, not user id, so a project can be shared with
-- someone who has no account yet AND with someone who is not a member of the
-- project's organization — the "outside counsel on one matter" case that org
-- membership cannot express. lib/access.ts merges a grant with any org
-- inheritance strongest-wins, so a grant can only ever add standing.
create table if not exists public.project_access_grants (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  email text not null,
  role text not null default 'member'
    check (role in ('admin', 'member', 'viewer')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, email),
  constraint project_access_grants_email_lowercase check (email = lower(email))
);

create index if not exists idx_project_access_grants_email
  on public.project_access_grants(email);
create index if not exists idx_project_access_grants_project
  on public.project_access_grants(project_id);

alter table public.project_access_grants enable row level security;

-- ---------------------------------------------------------------------------
-- Grants for the new tables
-- ---------------------------------------------------------------------------
-- Backend-only access, matching 20260728_audit_events / 20260809_01: revoke the
-- browser roles, and grant service_role explicitly — schema.sql's blanket
-- `grant ... on all tables` only covers fresh installs, so without this an
-- upgraded deployment's backend could not touch the new tables at all.

revoke all on public.organizations from anon, authenticated;
revoke all on public.org_members from anon, authenticated;
revoke all on public.org_invitations from anon, authenticated;
revoke all on public.project_access_grants from anon, authenticated;

grant select, insert, update, delete
  on public.organizations, public.org_members, public.org_invitations,
     public.project_access_grants
  to service_role;
