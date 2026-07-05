-- Projects: add a free-text "practice area" label.
--
-- `practice` is an optional label (e.g. "Corporate", "Litigation") that lets
-- teams tag projects by the practice group that owns them. It is purely
-- descriptive — no foreign key, no enum — so firms can use whatever taxonomy
-- they already have. Additive and nullable, so existing rows keep working.
--
-- Note on ordering: 20260702000000 is already taken by the user-profiles email
-- mirror, so this additive change lands at ...0001. The runner
-- (apps/api/scripts/migrate.mjs) applies each file in a single transaction and
-- strips any begin/commit, so this file carries none.
alter table public.projects
  add column if not exists practice text;

-- The projects overview RPC hand-picks the columns it returns, so a new table
-- column is invisible to the list view until we redefine the function to
-- surface it. This is a `create or replace` copy of the CURRENT definition
-- (last defined in 20260701000002_org_overview_rpcs.sql; the 20260702000000
-- email-mirror migration did not touch this function) with `practice` threaded
-- through both the RETURNS TABLE contract and the final SELECT. Everything else
-- — the visibility CTE (owner / shared_with / org membership), the count
-- roll-ups, and the ordering — is preserved verbatim.
create or replace function public.get_projects_overview(
  p_user_id uuid,
  p_user_email text default null
)
returns table (
  id uuid,
  user_id uuid,
  name text,
  cm_number text,
  practice text,
  shared_with jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  owner_display_name text,
  owner_email text,
  document_count integer,
  chat_count integer,
  review_count integer
)
language sql
stable
as $$
  with visible_projects as (
    select p.*
    from public.projects p
    where p.user_id = p_user_id
       or (
        coalesce(p_user_email, '') <> ''
        and p.user_id <> p_user_id
        and p.shared_with @> jsonb_build_array(lower(p_user_email))
      )
       or (
        p.org_id is not null
        and p.user_id <> p_user_id
        and exists (
          select 1 from public.org_members m
          where m.org_id = p.org_id and m.user_id = p_user_id
        )
      )
  ),
  document_counts as (
    select d.project_id, count(*)::integer as document_count
    from public.documents d
    where d.project_id in (select vp.id from visible_projects vp)
    group by d.project_id
  ),
  chat_counts as (
    select c.project_id, count(*)::integer as chat_count
    from public.chats c
    where c.project_id in (select vp.id from visible_projects vp)
    group by c.project_id
  ),
  review_counts as (
    select tr.project_id, count(*)::integer as review_count
    from public.tabular_reviews tr
    where tr.project_id in (select vp.id from visible_projects vp)
    group by tr.project_id
  )
  select
    vp.id,
    vp.user_id,
    vp.name,
    vp.cm_number,
    vp.practice,
    vp.shared_with,
    vp.created_at,
    vp.updated_at,
    vp.user_id = p_user_id as is_owner,
    nullif(trim(up.display_name), '') as owner_display_name,
    null::text as owner_email,
    coalesce(dc.document_count, 0) as document_count,
    coalesce(cc.chat_count, 0) as chat_count,
    coalesce(rc.review_count, 0) as review_count
  from visible_projects vp
  left join public.user_profiles up
    on up.user_id = vp.user_id
  left join document_counts dc
    on dc.project_id = vp.id
  left join chat_counts cc
    on cc.project_id = vp.id
  left join review_counts rc
    on rc.project_id = vp.id
  order by vp.created_at desc;
$$;
