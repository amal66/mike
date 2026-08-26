-- Migration date: 2026-08-25

-- get_chats_overview: align the list predicate with ensureChatAccess.
--
-- The overview RPCs re-implement the access helpers' logic in SQL; the two
-- must stay in lockstep or rows become readable through the detail endpoints
-- but invisible in the list views. The chats RPC was the one list still out of
-- lockstep with its detail route: it took no email, so a caller could open a
-- chat by URL through a project access grant (GET /chat/:id → 200 via
-- checkProjectAccess's grant branch) that never appeared in GET /chat.
--
-- Now that chats carry shared_with + org_id (20260825_10), the predicate is
-- the same four-branch shape as the other content RPCs, mirroring
-- ensureChatAccess exactly:
--
--   1. the chat's creator;
--   2. the caller's email in the chat's own shared_with (standalone shares);
--   3. the caller is a member of the chat's own org (a no-op in practice —
--      see the wrapper note below);
--   4. the chat's project is reachable, which is precisely
--      `project_access_role(...) is not null`: project creator, direct access
--      grant, or membership of the project's org. Calling 20260825_04's
--      helper rather than restating its three arms is what keeps this file
--      in lockstep with get_projects_overview for free.
--
-- Disclosed behaviour change: chats inside projects the caller reaches only
-- through an access grant (branch 4's grant arm) now appear in the global
-- list; they were previously reachable by URL but deliberately unlisted.

-- ---------------------------------------------------------------------------
-- Deploy-window compatibility: why the old 3-arg signature survives
-- ---------------------------------------------------------------------------
--
-- Migrations land BEFORE the code that needs them (migrate-then-deploy), and
-- during the rollout old and new API instances serve traffic side by side.
-- Dropping the 3-arg overload here would break every still-running pre-#363
-- instance the instant this file applies: GET /chat calls
--   rpc("get_chats_overview", { p_user_id, p_limit, p_offset })
-- and would get PGRST202 (function not found) until the last old pod is
-- replaced. So the old signature stays, re-created as a thin wrapper that
-- delegates to the new one.
--
-- The wrapper is a DEPLOY-WINDOW ARTEFACT ONLY. Once the rollout has
-- completed and no pre-#363 instance can still be serving, a follow-up
-- migration should
--   drop function if exists public.get_chats_overview(text, integer, integer);
-- and drop it from schema.sql in the same commit.
--
-- The trap this avoids -- and why p_user_email is NOT defaulted:
--
--   An overload pair only works if every call site resolves to exactly one
--   candidate. Had the new function kept `p_user_email text default null`,
--   the OLD call (three named arguments) would match BOTH functions, and
--   neither layer can pick a winner:
--
--     postgres:  ERROR 42725  function get_chats_overview(p_user_id => ...,
--                p_limit => integer, p_offset => integer) is not unique
--     postgrest: PGRST203     Could not choose the best candidate function
--
--   Making p_user_email required removes the overlap: a three-key call can
--   only be the wrapper (the new function has a required parameter the call
--   does not supply), and a four-key call can only be the new function (the
--   wrapper has no p_user_email parameter at all). Every caller in the tree
--   passes p_user_email explicitly, so requiring it costs nothing.
--
--   That disambiguation holds for NAMED arguments, which is how PostgREST --
--   the only caller -- invokes both. While the overload pair is in place,
--   call it by name from psql too: positional `get_chats_overview(x, null,
--   0)` leaves the second argument's type open and resolves to the new
--   four-argument function, not the wrapper.
--
-- Why the wrapper's rows are IDENTICAL to pre-migration behaviour, and not
-- merely "close enough" -- passing p_user_email => null replays the old
-- predicate branch for branch:
--
--   * branch 2 (chat shared_with) is gated on coalesce(p_user_email,'') <> ''
--     and so is switched off entirely; the old function had no such branch.
--   * branch 4 collapses to "project creator OR project-org member", because
--     project_access_role's grant arm carries the same email guard -- exactly
--     the old function's second and third branches.
--   * branch 3 (the chat's OWN org) has no old counterpart, but it can never
--     add a row: 20260825_10's backfill -- and resolveContentOrgId, which
--     writes the column going forward -- set chats.org_id to the project's
--     org for project chats (so branch 3 is a subset of branch 4) and leave
--     it NULL otherwise, which the branch's `c.org_id is not null` guard
--     skips. Old instances writing chats during the deploy window do not know
--     the column at all and also leave it null.
--
--   The wrapper also drops the new is_owner column, so an old instance's
--   `res.json(data)` returns the same six fields it always did.

create or replace function public.get_chats_overview(
  p_user_id text,
  p_user_email text,
  p_limit integer default null,
  p_offset integer default 0
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  created_at timestamptz,
  project_name text,
  is_owner boolean
)
language sql
stable
as $$
  select
    c.id,
    c.project_id,
    c.user_id::text as user_id,
    c.title,
    c.created_at,
    p.name as project_name,
    -- Provenance ("I started this thread"), not a role: the ladder itself is
    -- lib/permissions.ts, and the creator branch of ensureChatAccess is what
    -- turns this into admin standing.
    coalesce(c.user_id::text = p_user_id, false) as is_owner
  from public.chats c
  left join public.projects p on p.id = c.project_id
  where c.user_id::text = p_user_id
     or (
       coalesce(p_user_email, '') <> ''
       and c.user_id::text is distinct from p_user_id
       and c.shared_with @> jsonb_build_array(lower(p_user_email))
     )
     or (
       c.org_id is not null
       and c.user_id::text is distinct from p_user_id
       and exists (
         select 1 from public.org_members m
         where m.org_id = c.org_id and m.user_id::text = p_user_id
       )
     )
     or (
       p.id is not null
       and public.project_access_role(
             p.id, p.user_id, p.org_id, p_user_id, p_user_email
           ) is not null
     )
  order by c.created_at desc, c.id asc
  limit case
    when p_limit is null then null
    else greatest(1, least(p_limit, 100))
  end
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- Deploy-window shim only -- see the header. Drop in a follow-up migration
-- once every pre-#363 instance is gone.
create or replace function public.get_chats_overview(
  p_user_id text,
  p_limit integer default null,
  p_offset integer default 0
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  created_at timestamptz,
  project_name text
)
language sql
stable
as $$
  select
    o.id,
    o.project_id,
    o.user_id,
    o.title,
    o.created_at,
    o.project_name
  from public.get_chats_overview(p_user_id, null::text, p_limit, p_offset) o;
$$;

-- The new predicate probes chats.shared_with with the `@>` containment
-- operator, which only btree-scans as a full sequential filter.
-- tabular_reviews carries a GIN index for exactly this arm
-- (tabular_reviews_shared_with_idx); chats got the column in 20260825_10
-- without one, so give it the sibling index here.
create index if not exists chats_shared_with_idx
  on public.chats using gin (shared_with);

-- Refresh PostgREST's cached schema so the new four-argument overload is
-- callable immediately. This matters more here than for a column: PostgREST
-- resolves an RPC against its cache, so a new API instance calling
-- get_chats_overview with p_user_email would get PGRST202 ("function not
-- found") for as long as the stale cache survived — the mirror image of the
-- deploy-window problem the wrapper above solves. NOTIFY is idempotent and a
-- no-op where nothing is listening.
notify pgrst, 'reload schema';
