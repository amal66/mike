-- Migration date: 2026-08-27

-- Chat permission parity (schema + backfill).
--
-- Chats were the one content table left out of the organizations schema
-- (20260831_01): they gained the nullable `user_id` every project-tree table
-- got, but no `org_id` and no `shared_with`. That made them the only resource
-- family still on the pre-RBAC "row creator or nothing" model — a standalone
-- chat could never be shared, and neither lib/access.ts nor get_chats_overview
-- could derive for a chat the role ladder they derive for projects and
-- tabular reviews.
--
-- This migration gives `chats` the two columns the other content tables
-- carry, with the same semantics:
--
--   org_id      — nullable FK with ON DELETE SET NULL. Nullable because
--                 personal content has no organization: `org_id is null` IS
--                 the personal case, there is no hidden personal org to fall
--                 back on. SET NULL so dropping an org detaches its chats
--                 rather than deleting them, exactly as 20260831_01 does for
--                 projects/documents/workflows/reviews.
--   shared_with — per-chat email share list, so standalone chats
--                 (project_id null) can be shared directly, exactly like
--                 `tabular_reviews.shared_with`. Emails are written
--                 lowercased by the API from day one, so no normalization
--                 backfill will ever be needed for this column.
--
-- WHY CHATS KEEP shared_with WHILE PROJECTS DO NOT
-- 20260831_02 moved projects off `shared_with` and onto role-carrying
-- `project_access_grants` rows, because a project is the container people
-- administer: sharing one has to say WHAT the recipient may do. A chat is a
-- single thread inside (or outside) that container and carries no roles of
-- its own — every recipient is a content collaborator, i.e. 'member'. A
-- one-role grant table would be a second sharing mechanism with nothing to
-- express, so chats stay on the same roleless array tabular_reviews uses, and
-- lib/access.ts maps a direct chat share to 'member'.
--
-- Backfill matches what `resolveContentOrgId` does at creation time: a chat
-- inside a project inherits that project's org, and everything else stays
-- personal (org_id null). That is also what makes the chat's own org branch
-- in 20260831_05 safe — see that file's header.
--
-- Idempotent: the column adds are IF NOT EXISTS, the index adds are IF NOT
-- EXISTS, and the backfill is guarded by `where c.org_id is null`, so
-- re-running is a no-op.

alter table public.chats
  add column if not exists shared_with jsonb not null default '[]'::jsonb;
alter table public.chats
  add column if not exists org_id uuid
    references public.organizations(id) on delete set null;

create index if not exists idx_chats_org on public.chats(org_id);

-- Project chats inherit the project's org (creation-time semantics).
-- Standalone chats, and chats whose project has no org, are left null: they
-- are personal until their own shared_with names someone.
update public.chats c
set org_id = p.org_id
from public.projects p
where p.id = c.project_id
  and p.org_id is not null
  and c.org_id is null;

-- PostgREST answers requests from a CACHED copy of the schema; it does not
-- re-read the catalog per request. Until that cache is refreshed a column
-- added above does not exist as far as the API is concerned, and a write
-- naming it fails with PGRST204 ("column not found in schema cache") even
-- though the column is right there in Postgres. NOTIFY is the documented
-- refresh signal, it is idempotent, and it is harmless where nothing is
-- listening (a psql session, a test database), so it costs nothing to make
-- every deployment self-healing rather than depending on a restart.
notify pgrst, 'reload schema';
