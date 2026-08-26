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
-- Now that chats carry shared_with + org_id (20260828_04), a chat has exactly
-- the shape 20260828_03's review_access_role() already takes: creator, own
-- share list, containing project, own org — merged strongest-wins. So this
-- predicate does not restate those four branches, it CALLS that function:
--
--   review_access_role(c.user_id, c.project_id, c.shared_with, c.org_id,
--                      p_user_id, p_user_email) is not null
--
-- Its name comes from its first caller, not from a restriction. It is the SQL
-- twin of lib/access.ts's `ensureSharedRowAccess`, which `ensureReviewAccess`
-- and `ensureChatAccess` both delegate to for exactly this reason; chats carry
-- no column it does not take. (Renaming it to say so belongs in the migration
-- that introduced it, not here.)
--
-- Why delegate rather than restate: a copied predicate is a predicate that
-- drifts. List and detail disagreeing about what exists is the bug this file
-- exists to fix, and the surest way to reintroduce it is to keep a second copy
-- of the rule that a later change updates only once.
--
-- Verified equivalent rather than assumed: on a scratch Postgres carrying this
-- schema, the delegating predicate and the hand-written four-branch one were
-- run over eight chats covering every branch — creator's own, in an org
-- project, in a granted project, shared directly, tagged with an org but in no
-- project, a stranger's, and two whose creator's account was deleted so
-- user_id is NULL — for nine caller/email combinations including mixed case
-- and a NULL email (the wrapper's path). Identical row sets and identical
-- is_owner values; the symmetric difference was empty.
--
-- Disclosed behaviour change: chats inside projects the caller reaches only
-- through an access grant (the project arm's grant branch) now appear in the
-- global list; they were previously reachable by URL but deliberately
-- unlisted.

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
-- predicate arm for arm. Reading review_access_role's four arms in order:
--
--   * the share-list arm is gated on coalesce(p_user_email,'') <> '' and so is
--     switched off entirely; the old function had no such arm.
--   * the project arm collapses to "project creator OR project-org member",
--     because project_access_role's grant arm carries the same email guard --
--     exactly the old function's second and third branches.
--   * the row's OWN org arm has no old counterpart, but it can never add a
--     chat: 20260828_04's backfill -- and resolveContentOrgId, which writes
--     the column going forward -- set chats.org_id to the project's org for
--     project chats (making that arm a subset of the project arm) and leave it
--     NULL otherwise, which the arm's `p_org_id is not null` guard skips. Old
--     instances writing chats during the deploy window do not know the column
--     at all and also leave it null.
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
  model text,
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
    c.model,
    c.created_at,
    p.name as project_name,
    -- Provenance ("I started this thread"), not a role: the ladder itself is
    -- lib/permissions.ts, and the creator branch of ensureChatAccess is what
    -- turns this into admin standing.
    coalesce(c.user_id::text = p_user_id, false) as is_owner
  from public.chats c
  left join public.projects p on p.id = c.project_id
  -- The whole predicate, in one call -- see this function's header comment.
  -- The join above is for project_name only; the function resolves the
  -- project itself.
  where public.review_access_role(
          c.user_id,
          c.project_id,
          c.shared_with,
          c.org_id,
          p_user_id,
          p_user_email
        ) is not null
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
  model text,
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
    o.model,
    o.created_at,
    o.project_name
  from public.get_chats_overview(p_user_id, null::text, p_limit, p_offset) o;
$$;

-- jsonb containment (`shared_with @> '["someone@example.com"]'`) cannot use a
-- btree at all, so without a GIN index every such probe degrades to a
-- sequential scan of the whole table. tabular_reviews carries one for exactly
-- this predicate (tabular_reviews_shared_with_idx); chats got the column in
-- 20260828_04 without one, so give it the sibling index here.
--
-- The RPC above reaches the column through review_access_role(), so the
-- planner cannot use this index for the list query -- and could not have used
-- it for the hand-written predicate either, whose project arm is an
-- unindexable function call in the same OR. What the index does serve is the
-- direct containment queries: account deletion scrubbing a departing user's
-- email out of every share list (lib/userDataCleanup.ts) and the audit
-- lookups, both of which filter on this column alone.
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
