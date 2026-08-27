-- Migration date: 2026-08-27

-- The organization-aware list/overview RPCs, in their final form.
--
-- Every list surface in the app reads through one of these functions, and each
-- one had to learn the same lesson: a row is visible when the caller created
-- it, when they hold a direct access grant on its project, or when they belong
-- to its organization. Rather than restate that predicate a dozen times, the
-- two helpers below (project_access_role / review_access_role) resolve a
-- caller's role once and the RPCs use them for the `access_role` column they
-- now return, mirroring lib/permissions.ts exactly.
--
-- Two functions gain an output column (`access_role`, plus a finally-populated
-- `owner_email` on the project overview), and PostgreSQL will not let
-- `create or replace` change a result type — hence the drops. They are
-- `if exists`, so the file is re-runnable.

-- ---------------------------------------------------------------------------
-- Drop the functions whose result type changes
-- ---------------------------------------------------------------------------

drop function if exists public.get_projects_overview(text, text);
drop function if exists public.get_projects_overview(text, text, text, integer, integer, text, text, text, text, text);
drop function if exists public.get_tabular_reviews_overview(text, text, text, text, integer, integer, text, text, text);
drop function if exists public.get_tabular_reviews_overview(text, text, text);

-- ---------------------------------------------------------------------------
-- Role resolution, shared by every list RPC
-- ---------------------------------------------------------------------------
-- The same strongest-wins merge lib/access.ts performs in TypeScript, in one
-- place instead of once per RPC. A caller can reach a project as its creator,
-- through a direct access grant, or through membership of its organization;
-- when several apply the strongest role wins, so an extra grant can never
-- demote anybody.
--
-- Returns null when the caller has no access at all, which is how the list
-- RPCs' visibility predicates and this column stay consistent with each other.
create or replace function public.project_access_role(
  p_project_id uuid,
  p_project_user_id uuid,
  p_org_id uuid,
  p_user_id text,
  p_user_email text
)
returns text
language sql
stable
set search_path = public
as $$
  select r.role
  from (
    -- The creator holds an admin grant implicitly; no permanently elevated
    -- tier sits above it.
    select 'admin'::text as role, 3 as rank
    where p_project_user_id::text = p_user_id
    union all
    select g.role,
           case g.role when 'admin' then 3 when 'member' then 2 else 1 end
    from public.project_access_grants g
    where g.project_id = p_project_id
      and coalesce(p_user_email, '') <> ''
      and g.email = lower(p_user_email)
    union all
    -- Organization inheritance: admin -> project admin, member -> member.
    select case m.role when 'admin' then 'admin' else 'member' end,
           case m.role when 'admin' then 3 else 2 end
    from public.org_members m
    where p_org_id is not null
      and m.org_id = p_org_id
      and m.user_id::text = p_user_id
  ) r
  order by r.rank desc
  limit 1;
$$;

-- Same merge for a tabular review: its creator, its own share list (content
-- collaboration, so 'member'), whatever the containing project grants, and
-- the review's own organization.
create or replace function public.review_access_role(
  p_review_user_id uuid,
  p_project_id uuid,
  p_shared_with jsonb,
  p_org_id uuid,
  p_user_id text,
  p_user_email text
)
returns text
language sql
stable
set search_path = public
as $$
  select r.role
  from (
    select 'admin'::text as role, 3 as rank
    where p_review_user_id::text = p_user_id
    union all
    select 'member', 2
    where coalesce(p_user_email, '') <> ''
      and coalesce(p_shared_with, '[]'::jsonb) @> jsonb_build_array(lower(p_user_email))
    union all
    select pr.role,
           case pr.role when 'admin' then 3 when 'member' then 2 else 1 end
    from (
      select public.project_access_role(
               pj.id, pj.user_id, pj.org_id, p_user_id, p_user_email
             ) as role
      from public.projects pj
      where pj.id = p_project_id
    ) pr
    where pr.role is not null
    union all
    select case m.role when 'admin' then 'admin' else 'member' end,
           case m.role when 'admin' then 3 else 2 end
    from public.org_members m
    where p_org_id is not null
      and m.org_id = p_org_id
      and m.user_id::text = p_user_id
  ) r
  order by r.rank desc
  limit 1;
$$;

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
    c.id,
    c.project_id,
    c.user_id::text as user_id,
    c.title,
    c.model,
    c.created_at,
    p.name as project_name
  from public.chats c
  left join public.projects p on p.id = c.project_id
  where c.user_id::text = p_user_id
     or (
       p.id is not null
       and p.user_id::text = p_user_id
     )
     or (
       p.id is not null
       and p.org_id is not null
       and exists (
         select 1 from public.org_members m
         where m.org_id = p.org_id and m.user_id::text = p_user_id
       )
     )
  order by c.created_at desc, c.id asc
  limit case
    when p_limit is null then null
    else greatest(1, least(p_limit, 100))
  end
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.get_projects_overview(
  p_user_id text,
  p_user_email text default null
)
returns table (
  id uuid,
  user_id text,
  name text,
  cm_number text,
  practice text,
  shared_with jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  owner_display_name text,
  owner_email text,
  access_role text,
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
    where p.user_id::text = p_user_id
       or (
        coalesce(p_user_email, '') <> ''
        and (p.user_id is null or p.user_id::text <> p_user_id)
        and exists (
          select 1 from public.project_access_grants g
          where g.project_id = p.id and g.email = lower(p_user_email)
        )
      )
       or (
        p.org_id is not null
        and (p.user_id is null or p.user_id::text <> p_user_id)
        and exists (
          select 1 from public.org_members m
          where m.org_id = p.org_id and m.user_id::text = p_user_id
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
    vp.user_id::text as user_id,
    vp.name,
    vp.cm_number,
    vp.practice,
    vp.shared_with,
    vp.created_at,
    vp.updated_at,
    coalesce(vp.user_id::text = p_user_id, false) as is_owner,
    nullif(trim(up.display_name), '') as owner_display_name,
    -- Populated at last. The column has always been declared and always
    -- returned NULL, so the UI's "ask the project admin" line had no address
    -- to render and silently collapsed to nothing.
    up.email as owner_email,
    public.project_access_role(
      vp.id, vp.user_id, vp.org_id, p_user_id, p_user_email
    ) as access_role,
    coalesce(dc.document_count, 0) as document_count,
    coalesce(cc.chat_count, 0) as chat_count,
    coalesce(rc.review_count, 0) as review_count
  from visible_projects vp
  left join public.user_profiles up
    on up.user_id::text = vp.user_id::text
  left join document_counts dc
    on dc.project_id = vp.id
  left join chat_counts cc
    on cc.project_id = vp.id
  left join review_counts rc
    on rc.project_id = vp.id
  order by vp.created_at desc;
$$;

create or replace function public.get_projects_overview(
  p_user_id text,
  p_user_email text,
  p_scope text,
  p_limit integer,
  p_offset integer,
  p_search_term text,
  p_sort_key text,
  p_sort_direction text,
  p_practice text,
  p_owner_user_id text
)
returns table (
  id uuid,
  user_id text,
  name text,
  cm_number text,
  practice text,
  shared_with jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  owner_display_name text,
  owner_email text,
  access_role text,
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
    where (
        p.user_id::text = p_user_id
        or (
          coalesce(p_user_email, '') <> ''
          and (p.user_id is null or p.user_id::text <> p_user_id)
          and exists (
            select 1 from public.project_access_grants g
            where g.project_id = p.id and g.email = lower(p_user_email)
          )
        )
        or (
          p.org_id is not null
          and (p.user_id is null or p.user_id::text <> p_user_id)
          and exists (
            select 1 from public.org_members m
            where m.org_id = p.org_id and m.user_id::text = p_user_id
          )
        )
      )
      and (
        coalesce(p_scope, 'all') = 'all'
        or (p_scope = 'mine' and p.user_id::text = p_user_id)
        or (p_scope = 'shared' and (p.user_id is null or p.user_id::text <> p_user_id))
      )
      and (
        p_search_term is null
        or p_search_term = ''
        or lower(coalesce(p.name, '')) like
          '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          escape '\'
        or lower(coalesce(p.cm_number, '')) like
          '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          escape '\'
        or lower(coalesce(p.practice, '')) like
          '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          escape '\'
      )
      and (p_practice is null or p.practice = p_practice)
      and (p_owner_user_id is null or p.user_id::text = p_owner_user_id)
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
    vp.user_id::text as user_id,
    vp.name,
    vp.cm_number,
    vp.practice,
    vp.shared_with,
    vp.created_at,
    vp.updated_at,
    coalesce(vp.user_id::text = p_user_id, false) as is_owner,
    nullif(trim(up.display_name), '') as owner_display_name,
    -- Populated at last. The column has always been declared and always
    -- returned NULL, so the UI's "ask the project admin" line had no address
    -- to render and silently collapsed to nothing.
    up.email as owner_email,
    public.project_access_role(
      vp.id, vp.user_id, vp.org_id, p_user_id, p_user_email
    ) as access_role,
    coalesce(dc.document_count, 0) as document_count,
    coalesce(cc.chat_count, 0) as chat_count,
    coalesce(rc.review_count, 0) as review_count
  from visible_projects vp
  left join public.user_profiles up
    on up.user_id::text = vp.user_id::text
  left join document_counts dc
    on dc.project_id = vp.id
  left join chat_counts cc
    on cc.project_id = vp.id
  left join review_counts rc
    on rc.project_id = vp.id
  order by
    case when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(vp.name, '')) else null end asc,
    case when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(vp.name, '')) else null end desc,
    case when p_sort_key = 'cm' and p_sort_direction = 'asc' then lower(coalesce(vp.cm_number, '')) else null end asc,
    case when p_sort_key = 'cm' and p_sort_direction = 'desc' then lower(coalesce(vp.cm_number, '')) else null end desc,
    case when p_sort_key = 'files' and p_sort_direction = 'asc' then coalesce(dc.document_count, 0) else null end asc,
    case when p_sort_key = 'files' and p_sort_direction = 'desc' then coalesce(dc.document_count, 0) else null end desc,
    case when p_sort_key = 'chats' and p_sort_direction = 'asc' then coalesce(cc.chat_count, 0) else null end asc,
    case when p_sort_key = 'chats' and p_sort_direction = 'desc' then coalesce(cc.chat_count, 0) else null end desc,
    case when p_sort_key = 'reviews' and p_sort_direction = 'asc' then coalesce(rc.review_count, 0) else null end asc,
    case when p_sort_key = 'reviews' and p_sort_direction = 'desc' then coalesce(rc.review_count, 0) else null end desc,
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then vp.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then vp.created_at else null end desc,
    case when p_sort_key = 'updated' and p_sort_direction = 'asc' then vp.updated_at else null end asc,
    case when p_sort_key = 'updated' and p_sort_direction = 'desc' then vp.updated_at else null end desc,
    vp.created_at desc,
    vp.id asc
  limit greatest(coalesce(p_limit, 20), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- Lightweight companion for bulk "select all matching" actions — id + owning
-- user only, no count joins. Duplicates visible_projects' predicate rather
-- than delegating to get_projects_overview (same rationale as
-- get_tabular_review_ids_overview: the count CTEs there would be pure waste
-- for a caller that only wants ids). Keep this predicate in sync by hand if
-- visible_projects above ever changes.
--
-- Paginated (not "return everything") because PostgREST enforces its own
-- row cap on every RPC response and truncates silently rather than erroring;
-- backend/src/routes/projects.ts pages through this on the caller's behalf.
create or replace function public.get_project_ids_overview(
  p_user_id text,
  p_user_email text,
  p_scope text,
  p_search_term text,
  p_practice text,
  p_owner_user_id text,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  user_id text
)
language sql
stable
as $$
  select p.id, p.user_id::text as user_id
  from public.projects p
  where (
      p.user_id::text = p_user_id
      or (
        coalesce(p_user_email, '') <> ''
        and (p.user_id is null or p.user_id::text <> p_user_id)
        and exists (
          select 1 from public.project_access_grants g
          where g.project_id = p.id and g.email = lower(p_user_email)
        )
      )
      or (
        p.org_id is not null
        and (p.user_id is null or p.user_id::text <> p_user_id)
        and exists (
          select 1 from public.org_members m
          where m.org_id = p.org_id and m.user_id::text = p_user_id
        )
      )
    )
    and (
      coalesce(p_scope, 'all') = 'all'
      or (p_scope = 'mine' and p.user_id::text = p_user_id)
      or (p_scope = 'shared' and (p.user_id is null or p.user_id::text <> p_user_id))
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(coalesce(p.name, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
      or lower(coalesce(p.cm_number, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
      or lower(coalesce(p.practice, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (p_practice is null or p.practice = p_practice)
    and (p_owner_user_id is null or p.user_id::text = p_owner_user_id)
  order by p.created_at desc, p.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- Lightweight sidebar project feed. The Projects overview RPC intentionally
-- computes file/chat/review counts for table sorting; the sidebar needs none
-- of those aggregates.
create or replace function public.get_project_summaries(
  p_user_id text,
  p_user_email text,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  user_id text,
  name text,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean
)
language sql
stable
as $$
  select
    p.id,
    p.user_id::text as user_id,
    p.name,
    p.created_at,
    p.updated_at,
    coalesce(p.user_id::text = p_user_id, false) as is_owner
  from public.projects p
  where p.user_id::text = p_user_id
     or (
       coalesce(p_user_email, '') <> ''
       and (p.user_id is null or p.user_id::text <> p_user_id)
       and exists (
         select 1 from public.project_access_grants g
         where g.project_id = p.id and g.email = lower(p_user_email)
       )
     )
     or (
       p.org_id is not null
       and (p.user_id is null or p.user_id::text <> p_user_id)
       and exists (
         select 1 from public.org_members m
         where m.org_id = p.org_id and m.user_id::text = p_user_id
       )
     )
  order by p.updated_at desc, p.created_at desc, p.id asc
  limit greatest(coalesce(p_limit, 11), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.get_workflows_overview(
  p_user_id text,
  p_user_email text default null,
  p_type text default null
)
returns table (
  id uuid,
  user_id text,
  title text,
  type text,
  prompt_md text,
  columns_config jsonb,
  language text,
  practice text,
  jurisdictions text[],
  is_system boolean,
  created_at timestamptz,
  allow_edit boolean,
  is_owner boolean,
  shared_by_name text
)
language sql
stable
as $$
  with owned as (
    select
      w.id,
      w.user_id::text as user_id,
      w.title,
      w.type,
      w.prompt_md,
      w.columns_config,
      w.language,
      w.practice,
      w.jurisdictions,
      false as is_system,
      w.created_at,
      true as allow_edit,
      true as is_owner,
      null::text as shared_by_name,
      0 as sort_bucket
    from public.workflows w
    where w.user_id::text = p_user_id
      and (p_type is null or w.type = p_type)
  ),
  shared as (
    select
      w.id,
      w.user_id::text as user_id,
      w.title,
      w.type,
      w.prompt_md,
      w.columns_config,
      w.language,
      w.practice,
      w.jurisdictions,
      false as is_system,
      w.created_at,
      ws.allow_edit,
      false as is_owner,
      nullif(trim(up.display_name), '') as shared_by_name,
      1 as sort_bucket
    from public.workflow_shares ws
    join public.workflows w
      on w.id = ws.workflow_id
    left join public.user_profiles up
      on up.user_id::text = ws.shared_by_user_id::text
    where lower(ws.shared_with_email) = lower(coalesce(p_user_email, ''))
      and (p_type is null or w.type = p_type)
  ),
  org_shared as (
    -- Workflows in an org the caller belongs to. Editable: an org workflow
    -- belongs to the ORGANIZATION, and both org roles sit at member or above
    -- on the project ladder where editing content is a member capability.
    -- Mirrors resolveWorkflowAccess in routes/workflows.ts, so a row's
    -- affordances in the list match what the detail route will allow.
    select
      w.id,
      w.user_id::text as user_id,
      w.title,
      w.type,
      w.prompt_md,
      w.columns_config,
      w.language,
      w.practice,
      w.jurisdictions,
      false as is_system,
      w.created_at,
      true as allow_edit,
      false as is_owner,
      nullif(trim(up.display_name), '') as shared_by_name,
      2 as sort_bucket
    from public.workflows w
    left join public.user_profiles up
      on up.user_id::text = w.user_id::text
    where w.org_id is not null
      and (w.user_id is null or w.user_id::text <> p_user_id)
      and (p_type is null or w.type = p_type)
      and exists (
        select 1 from public.org_members m
        where m.org_id = w.org_id and m.user_id::text = p_user_id
      )
      and not exists (
        select 1 from public.workflow_shares ws
        where ws.workflow_id = w.id
          and lower(ws.shared_with_email) = lower(coalesce(p_user_email, ''))
      )
  ),
  visible_workflows as (
    select * from owned
    union all
    select * from shared
    union all
    select * from org_shared
  )
  select
    vw.id,
    vw.user_id,
    vw.title,
    vw.type,
    vw.prompt_md,
    vw.columns_config,
    vw.language,
    vw.practice,
    vw.jurisdictions,
    vw.is_system,
    vw.created_at,
    vw.allow_edit,
    vw.is_owner,
    vw.shared_by_name
  from visible_workflows vw
  order by vw.sort_bucket asc, vw.created_at desc;
$$;

-- p_scope here is 'all' | 'owned' | 'shared' — deliberately different
-- vocabulary from Projects' 'mine'/'shared', since this RPC (unlike
-- Projects' single source of truth) never includes system workflows at all;
-- keeping the words distinct avoids conflating this RPC-level scope with the
-- UI's separate "source" filter (system/user/shared), which does include
-- system rows client-side.
create or replace function public.get_workflows_overview(
  p_user_id text,
  p_user_email text,
  p_type text,
  p_scope text,
  p_limit integer,
  p_offset integer,
  p_search_term text,
  p_sort_key text,
  p_sort_direction text,
  p_practice text,
  p_language text,
  p_jurisdiction text
)
returns table (
  id uuid,
  user_id text,
  title text,
  type text,
  prompt_md text,
  columns_config jsonb,
  language text,
  practice text,
  jurisdictions text[],
  is_system boolean,
  created_at timestamptz,
  allow_edit boolean,
  is_owner boolean,
  shared_by_name text
)
language sql
stable
as $$
  with owned as (
    select
      w.id, w.user_id::text as user_id, w.title, w.type, w.prompt_md,
      w.columns_config, w.language, w.practice, w.jurisdictions,
      false as is_system, w.created_at,
      true as allow_edit, true as is_owner, null::text as shared_by_name,
      0 as sort_bucket
    from public.workflows w
    where w.user_id::text = p_user_id
      and (p_type is null or w.type = p_type)
  ),
  shared as (
    select
      w.id, w.user_id::text as user_id, w.title, w.type, w.prompt_md,
      w.columns_config, w.language, w.practice, w.jurisdictions,
      false as is_system, w.created_at,
      ws.allow_edit, false as is_owner,
      nullif(trim(up.display_name), '') as shared_by_name,
      1 as sort_bucket
    from public.workflow_shares ws
    join public.workflows w
      on w.id = ws.workflow_id
    left join public.user_profiles up
      on up.user_id::text = ws.shared_by_user_id::text
    where lower(ws.shared_with_email) = lower(coalesce(p_user_email, ''))
      and (p_type is null or w.type = p_type)
  ),
  org_shared as (
    -- Workflows in an org the caller belongs to. Editable: an org workflow
    -- belongs to the ORGANIZATION, and both org roles sit at member or above
    -- on the project ladder where editing content is a member capability.
    -- Mirrors resolveWorkflowAccess in routes/workflows.ts and the legacy
    -- 3-argument overload. Under the scope filter these rows count as
    -- "shared" — shared-with-me and shared-via-my-org are one bucket from
    -- the caller's point of view.
    select
      w.id, w.user_id::text as user_id, w.title, w.type, w.prompt_md,
      w.columns_config, w.language, w.practice, w.jurisdictions,
      false as is_system, w.created_at,
      true as allow_edit, false as is_owner,
      nullif(trim(up.display_name), '') as shared_by_name,
      2 as sort_bucket
    from public.workflows w
    left join public.user_profiles up
      on up.user_id::text = w.user_id::text
    where w.org_id is not null
      and (w.user_id is null or w.user_id::text <> p_user_id)
      and (p_type is null or w.type = p_type)
      and exists (
        select 1 from public.org_members m
        where m.org_id = w.org_id and m.user_id::text = p_user_id
      )
      and not exists (
        select 1 from public.workflow_shares ws
        where ws.workflow_id = w.id
          and lower(ws.shared_with_email) = lower(coalesce(p_user_email, ''))
      )
  ),
  visible_workflows as (
    select * from owned
    union all
    select * from shared
    union all
    select * from org_shared
  )
  select
    vw.id, vw.user_id, vw.title, vw.type, vw.prompt_md, vw.columns_config,
    vw.language, vw.practice, vw.jurisdictions, vw.is_system, vw.created_at,
    vw.allow_edit, vw.is_owner, vw.shared_by_name
  from visible_workflows vw
  where (
      coalesce(p_scope, 'all') = 'all'
      or (p_scope = 'owned' and vw.sort_bucket = 0)
      or (p_scope = 'shared' and vw.sort_bucket in (1, 2))
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(vw.title) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (p_practice is null or vw.practice = p_practice)
    and (p_language is null or vw.language = p_language)
    and (p_jurisdiction is null or vw.jurisdictions @> array[p_jurisdiction])
  order by
    case when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(vw.title, '')) else null end asc,
    case when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(vw.title, '')) else null end desc,
    case when p_sort_key = 'type' and p_sort_direction = 'asc' then vw.type else null end asc,
    case when p_sort_key = 'type' and p_sort_direction = 'desc' then vw.type else null end desc,
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then vw.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then vw.created_at else null end desc,
    vw.sort_bucket asc,
    vw.created_at desc,
    vw.id asc
  limit greatest(coalesce(p_limit, 20), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- Lightweight companion for bulk "select all matching" actions (owned
-- workflows only — see the route/hook layer; shared workflows are excluded
-- from bulk-delete eligibility since only the owner can delete, and system
-- workflows never need this since all 37 are always already in memory).
-- Duplicates the owned predicate directly rather than delegating to
-- get_workflows_overview, same rationale as get_project_ids_overview: no
-- need for the shared-by-name join when the caller only wants ids.
create or replace function public.get_workflow_ids_overview(
  p_user_id text,
  p_user_email text,
  p_type text,
  p_scope text,
  p_search_term text,
  p_practice text,
  p_language text,
  p_jurisdiction text,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  user_id text
)
language sql
stable
as $$
  with owned as (
    select w.id, w.user_id::text as user_id, w.title, w.practice, w.language, w.jurisdictions,
      w.created_at, 0 as sort_bucket
    from public.workflows w
    where w.user_id::text = p_user_id
      and (p_type is null or w.type = p_type)
  ),
  shared as (
    select w.id, w.user_id::text as user_id, w.title, w.practice, w.language, w.jurisdictions,
      w.created_at, 1 as sort_bucket
    from public.workflow_shares ws
    join public.workflows w
      on w.id = ws.workflow_id
    where lower(ws.shared_with_email) = lower(coalesce(p_user_email, ''))
      and (p_type is null or w.type = p_type)
  ),
  org_shared as (
    -- Same org-membership arm as get_workflows_overview: the ids RPC must
    -- compute the same visible set, or "select all matching" silently
    -- omits org-shared rows the list view shows.
    select w.id, w.user_id::text as user_id, w.title, w.practice, w.language, w.jurisdictions,
      w.created_at, 2 as sort_bucket
    from public.workflows w
    where w.org_id is not null
      and (w.user_id is null or w.user_id::text <> p_user_id)
      and (p_type is null or w.type = p_type)
      and exists (
        select 1 from public.org_members m
        where m.org_id = w.org_id and m.user_id::text = p_user_id
      )
      and not exists (
        select 1 from public.workflow_shares ws
        where ws.workflow_id = w.id
          and lower(ws.shared_with_email) = lower(coalesce(p_user_email, ''))
      )
  ),
  visible_workflows as (
    select * from owned
    union all
    select * from shared
    union all
    select * from org_shared
  )
  select vw.id, vw.user_id
  from visible_workflows vw
  where (
      coalesce(p_scope, 'all') = 'all'
      or (p_scope = 'owned' and vw.sort_bucket = 0)
      or (p_scope = 'shared' and vw.sort_bucket in (1, 2))
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(vw.title) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (p_practice is null or vw.practice = p_practice)
    and (p_language is null or vw.language = p_language)
    and (p_jurisdiction is null or vw.jurisdictions @> array[p_jurisdiction])
  order by vw.sort_bucket asc, vw.created_at desc, vw.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.get_tabular_reviews_overview(
  p_user_id text,
  p_user_email text,
  p_project_id text,
  p_scope text,
  p_limit integer,
  p_offset integer,
  p_search_term text,
  p_sort_key text,
  p_sort_direction text
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  columns_config jsonb,
  document_ids jsonb,
  workflow_id uuid,
  shared_with jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  access_role text,
  document_count integer
)
language sql
stable
as $$
  with accessible_projects as (
    select p.id
    from public.projects p
    where p.user_id::text = p_user_id
       or (
        coalesce(p_user_email, '') <> ''
        and (p.user_id is null or p.user_id::text <> p_user_id)
        and exists (
          select 1 from public.project_access_grants g
          where g.project_id = p.id and g.email = lower(p_user_email)
        )
      )
       or (
        p.org_id is not null
        and (p.user_id is null or p.user_id::text <> p_user_id)
        and exists (
          select 1 from public.org_members m
          where m.org_id = p.org_id and m.user_id::text = p_user_id
        )
      )
  ),
  visible_reviews as (
    select tr.*
    from public.tabular_reviews tr
    where (p_project_id is null or tr.project_id::text = p_project_id)
      and (
        coalesce(p_scope, 'all') = 'all'
        or (p_scope = 'in-project' and tr.project_id is not null)
        or (p_scope = 'standalone' and tr.project_id is null)
      )
      and (
        p_search_term is null
        or p_search_term = ''
        or lower(tr.title) like
          '%' ||
          replace(
            replace(
              replace(lower(p_search_term), '\', '\\'),
              '%',
              '\%'
            ),
            '_',
            '\_'
          ) ||
          '%'
          escape '\'
      )
      and (
        p_project_id is null
        or exists (
          select 1
          from accessible_projects ap
          where ap.id::text = p_project_id
        )
      )
      and (
        tr.user_id::text = p_user_id
        or (
          tr.project_id in (select ap.id from accessible_projects ap)
          and (tr.user_id is null or tr.user_id::text <> p_user_id)
        )
        or (
          p_project_id is null
          and coalesce(p_user_email, '') <> ''
          and (tr.user_id is null or tr.user_id::text <> p_user_id)
          and tr.shared_with @> jsonb_build_array(lower(p_user_email))
        )
        or (
          p_project_id is null
          and tr.org_id is not null
          and (tr.user_id is null or tr.user_id::text <> p_user_id)
          and exists (
            select 1 from public.org_members m
            where m.org_id = tr.org_id and m.user_id::text = p_user_id
          )
        )
      )
  ),
  cell_document_counts as (
    select
      tc.review_id,
      count(distinct tc.document_id)::integer as document_count
    from public.tabular_cells tc
    where tc.review_id in (
      select vr.id
      from visible_reviews vr
      where jsonb_typeof(vr.document_ids) is distinct from 'array'
    )
    group by tc.review_id
  ),
  review_document_counts as (
    select
      vr.id,
      case
        when jsonb_typeof(vr.document_ids) = 'array'
          then (
            select count(distinct doc_id.value)::integer
            from jsonb_array_elements_text(vr.document_ids) as doc_id(value)
          )
        else coalesce(cdc.document_count, 0)
      end as document_count
    from visible_reviews vr
    left join cell_document_counts cdc
      on cdc.review_id = vr.id
  )
  select
    vr.id,
    vr.project_id,
    vr.user_id::text as user_id,
    vr.title,
    vr.columns_config,
    vr.document_ids,
    vr.workflow_id,
    vr.shared_with,
    vr.created_at,
    vr.updated_at,
    coalesce(vr.user_id::text = p_user_id, false) as is_owner,
    public.review_access_role(
      vr.user_id, vr.project_id, vr.shared_with, vr.org_id,
      p_user_id, p_user_email
    ) as access_role,
    rdc.document_count
  from visible_reviews vr
  join review_document_counts rdc
    on rdc.id = vr.id
  order by
    case
      when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(vr.title, ''))
      else null
    end asc,
    case
      when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(vr.title, ''))
      else null
    end desc,
    case
      when p_sort_key = 'columns' and p_sort_direction = 'asc' then jsonb_array_length(coalesce(vr.columns_config, '[]'::jsonb))
      else null
    end asc,
    case
      when p_sort_key = 'columns' and p_sort_direction = 'desc' then jsonb_array_length(coalesce(vr.columns_config, '[]'::jsonb))
      else null
    end desc,
    case
      when p_sort_key = 'documents' and p_sort_direction = 'asc' then rdc.document_count
      else null
    end asc,
    case
      when p_sort_key = 'documents' and p_sort_direction = 'desc' then rdc.document_count
      else null
    end desc,
    case
      when p_sort_key = 'created' and p_sort_direction = 'asc' then vr.created_at
      else null
    end asc,
    case
      when p_sort_key = 'created' and p_sort_direction = 'desc' then vr.created_at
      else null
    end desc,
    vr.created_at desc,
    vr.id asc
  limit greatest(coalesce(p_limit, 20), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.get_tabular_reviews_overview(
  p_user_id text,
  p_user_email text default null,
  p_project_id text default null
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  columns_config jsonb,
  document_ids jsonb,
  workflow_id uuid,
  shared_with jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  access_role text,
  document_count integer
)
language sql
stable
as $$
  select *
  from public.get_tabular_reviews_overview(
    p_user_id,
    p_user_email,
    p_project_id,
    'all',
    2147483647,
    0,
    null,
    'created',
    'desc'
  );
$$;

create or replace function public.get_tabular_review_ids_overview(
  p_user_id text,
  p_user_email text,
  p_project_id text,
  p_scope text,
  p_search_term text,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  user_id text
)
language sql
stable
as $$
  with accessible_projects as (
    select p.id
    from public.projects p
    where p.user_id::text = p_user_id
       or (
        coalesce(p_user_email, '') <> ''
        and (p.user_id is null or p.user_id::text <> p_user_id)
        and exists (
          select 1 from public.project_access_grants g
          where g.project_id = p.id and g.email = lower(p_user_email)
        )
      )
       or (
        p.org_id is not null
        and (p.user_id is null or p.user_id::text <> p_user_id)
        and exists (
          select 1 from public.org_members m
          where m.org_id = p.org_id and m.user_id::text = p_user_id
        )
      )
  )
  select tr.id, tr.user_id::text as user_id
  from public.tabular_reviews tr
  where (p_project_id is null or tr.project_id::text = p_project_id)
    and (
      coalesce(p_scope, 'all') = 'all'
      or (p_scope = 'in-project' and tr.project_id is not null)
      or (p_scope = 'standalone' and tr.project_id is null)
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(tr.title) like
        '%' ||
        replace(
          replace(
            replace(lower(p_search_term), '\', '\\'),
            '%',
            '\%'
          ),
          '_',
          '\_'
        ) ||
        '%'
        escape '\'
    )
    and (
      p_project_id is null
      or exists (
        select 1
        from accessible_projects ap
        where ap.id::text = p_project_id
      )
    )
    and (
      tr.user_id::text = p_user_id
      or (
        tr.project_id in (select ap.id from accessible_projects ap)
        and (tr.user_id is null or tr.user_id::text <> p_user_id)
      )
      or (
        p_project_id is null
        and coalesce(p_user_email, '') <> ''
        and (tr.user_id is null or tr.user_id::text <> p_user_id)
        and tr.shared_with @> jsonb_build_array(lower(p_user_email))
      )
      or (
        p_project_id is null
        and tr.org_id is not null
        and (tr.user_id is null or tr.user_id::text <> p_user_id)
        and exists (
          select 1 from public.org_members m
          where m.org_id = tr.org_id and m.user_id::text = p_user_id
        )
      )
    )
  order by tr.created_at desc, tr.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.get_project_filter_options(
  p_user_id text,
  p_user_email text default null
)
returns table (practices text[], owners jsonb)
language sql
stable
as $$
  with visible_projects as (
    select p.user_id, nullif(trim(p.practice), '') as practice
    from public.projects p
    where p.user_id::text = p_user_id
       or (
         coalesce(p_user_email, '') <> ''
         and (p.user_id is null or p.user_id::text <> p_user_id)
         and exists (
           select 1 from public.project_access_grants g
           where g.project_id = p.id and g.email = lower(p_user_email)
         )
       )
       or (
         -- Org arm: same predicate as get_projects_overview, so the filter
         -- dropdowns and the list agree on what is visible.
         p.org_id is not null
         and (p.user_id is null or p.user_id::text <> p_user_id)
         and exists (
           select 1 from public.org_members m
           where m.org_id = p.org_id and m.user_id::text = p_user_id
         )
       )
  ),
  distinct_owners as (
    -- NULL is not an owner. A project whose creator's account was deleted
    -- carries user_id = NULL (on delete set null), and emitting it here put
    -- an option with value null in the owner dropdown -- selecting which made
    -- `p_owner_user_id is null or ...` true for EVERY row, so the filter
    -- silently turned itself off instead of filtering.
    select distinct vp.user_id
    from visible_projects vp
    where vp.user_id is not null
  ),
  owner_options as (
    select
      o.user_id,
      case
        when o.user_id::text = p_user_id then 'Me'
        else coalesce(
          nullif(trim(up.display_name), ''),
          nullif(trim(up.email), ''),
          'Shared'
        )
      end as label
    from distinct_owners o
    left join public.user_profiles up
      on up.user_id::text = o.user_id::text
  )
  select
    coalesce(
      (select array_agg(distinct practice order by practice)
       from visible_projects
       where practice is not null),
      array[]::text[]
    ) as practices,
    coalesce(
      (select jsonb_agg(
          jsonb_build_object('value', user_id, 'label', label)
          order by label, user_id
       ) from owner_options),
      '[]'::jsonb
    ) as owners;
$$;

create or replace function public.get_workflow_filter_options(
  p_user_id text,
  p_user_email text default null,
  p_type text default null,
  p_scope text default 'all'
)
returns table (
  practices text[],
  languages text[],
  jurisdictions text[]
)
language sql
stable
as $$
  with owned as (
    select w.practice, w.language, w.jurisdictions, 'owned'::text as source
    from public.workflows w
    where w.user_id::text = p_user_id
      and (p_type is null or w.type = p_type)
  ),
  shared as (
    select w.practice, w.language, w.jurisdictions, 'shared'::text as source
    from public.workflow_shares ws
    join public.workflows w on w.id = ws.workflow_id
    where lower(ws.shared_with_email) = lower(coalesce(p_user_email, ''))
      and (p_type is null or w.type = p_type)
  ),
  org_shared as (
    -- Same org-membership arm as get_workflows_overview, including the
    -- workflow_shares NOT EXISTS dedup, so a row visible via both routes
    -- contributes its options exactly once. Tagged 'shared' to match the
    -- overview's scope bucketing.
    select w.practice, w.language, w.jurisdictions, 'shared'::text as source
    from public.workflows w
    where w.org_id is not null
      and (w.user_id is null or w.user_id::text <> p_user_id)
      and (p_type is null or w.type = p_type)
      and exists (
        select 1 from public.org_members m
        where m.org_id = w.org_id and m.user_id::text = p_user_id
      )
      and not exists (
        select 1 from public.workflow_shares ws
        where ws.workflow_id = w.id
          and lower(ws.shared_with_email) = lower(coalesce(p_user_email, ''))
      )
  ),
  visible as (
    select * from owned
    union all
    select * from shared
    union all
    select * from org_shared
  ),
  scoped as (
    select * from visible
    where coalesce(p_scope, 'all') = 'all' or source = p_scope
  )
  select
    coalesce(
      array_agg(distinct nullif(trim(practice), '') order by nullif(trim(practice), ''))
        filter (where nullif(trim(practice), '') is not null),
      array[]::text[]
    ) as practices,
    coalesce(
      array_agg(distinct nullif(trim(language), '') order by nullif(trim(language), ''))
        filter (where nullif(trim(language), '') is not null),
      array[]::text[]
    ) as languages,
    coalesce(
      (select array_agg(distinct jurisdiction order by jurisdiction)
       from scoped s
       cross join lateral unnest(coalesce(s.jurisdictions, array[]::text[])) jurisdiction
       where nullif(trim(jurisdiction), '') is not null),
      array[]::text[]
    ) as jurisdictions
  from scoped;
$$;
