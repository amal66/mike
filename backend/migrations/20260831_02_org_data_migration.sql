-- Migration date: 2026-08-27

-- Data migration for the organizations feature: move direct project sharing
-- into project_access_grants, and normalize the review share lists.
--
-- Runs after 20260831_01 has created the tables. Both passes are idempotent:
-- the grant backfill is an `on conflict do nothing` insert driven by the
-- current shared_with contents, and the review normalization only writes rows
-- whose stored value actually differs.

-- ---------------------------------------------------------------------------
-- projects.shared_with -> project_access_grants
-- ---------------------------------------------------------------------------
-- Every existing share was roleless and behaved like a content collaborator,
-- so 'member' is the faithful translation: it can edit content, upload
-- documents and organize folders, but not re-share the project or delete it.
-- Promoting anyone to 'admin' here would silently GRANT rights nobody had
-- agreed to; demoting to 'viewer' would silently remove rights people were
-- using. 'member' is the only choice that changes nothing.
--
-- The project's own creator is deliberately NOT given a grant row: lib/access.ts
-- derives admin for `projects.user_id` directly, and a row would only be a
-- second source of truth to keep in sync.

insert into public.project_access_grants (project_id, email, role, created_by)
select
  p.id,
  lower(trim(entry.value)) as email,
  'member',
  p.user_id
from public.projects p
cross join lateral jsonb_array_elements_text(
  case
    when jsonb_typeof(p.shared_with) = 'array' then p.shared_with
    else '[]'::jsonb
  end
) as entry(value)
where trim(entry.value) <> ''
  and position('@' in entry.value) > 0
on conflict (project_id, email) do nothing;

-- Re-write the array from the grants so the mirror and its source agree from
-- the very first moment. routes/projects.ts keeps them in step from here on
-- (see lib/projectAccess.ts: syncSharedWithMirror); the column stays only
-- because the un-revised web UI still reads it.
update public.projects p
set shared_with = coalesce(
  (
    select jsonb_agg(g.email order by g.created_at, g.email)
    from public.project_access_grants g
    where g.project_id = p.id
  ),
  '[]'::jsonb
)
where p.shared_with is distinct from coalesce(
  (
    select jsonb_agg(g.email order by g.created_at, g.email)
    from public.project_access_grants g
    where g.project_id = p.id
  ),
  '[]'::jsonb
);

-- ---------------------------------------------------------------------------
-- tabular_reviews.shared_with normalization
-- ---------------------------------------------------------------------------
-- Normalize legacy tabular_reviews.shared_with entries the way 20260814_01
-- normalized projects.shared_with.
--
-- That migration lowercased only project shares. Review shares have the same
-- jsonb email-list shape and the same indexed containment consumers — the
-- write path normalizes new entries (routes/tabular.ts) and the TypeScript
-- detail check lowercases both sides (ensureReviewAccess), but the list/ids
-- RPCs compare the STORED value against an already-lowercased caller email
-- (tr.shared_with @> jsonb_build_array(p_user_email)). A pre-normalization
-- mixed-case entry is therefore admitted by detail endpoints yet invisible
-- in every list — a review you can open from a link but never find. Data is
-- the right place to fix a data inconsistency: one pass, and the stored form
-- matches what every predicate expects.

with normalized_reviews as (
  select
    tr.id,
    coalesce(
      jsonb_agg(entries.email order by entries.first_position)
        filter (where entries.email is not null),
      '[]'::jsonb
    ) as shared_with
  from public.tabular_reviews tr
  left join lateral (
    select
      lower(trim(raw.value)) as email,
      min(raw.position) as first_position
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(tr.shared_with) = 'array' then tr.shared_with
        else '[]'::jsonb
      end
    ) with ordinality as raw(value, position)
    where trim(raw.value) <> ''
    group by lower(trim(raw.value))
  ) entries on true
  group by tr.id
)
update public.tabular_reviews tr
set shared_with = normalized_reviews.shared_with
from normalized_reviews
where tr.id = normalized_reviews.id
  and tr.shared_with is distinct from normalized_reviews.shared_with;
