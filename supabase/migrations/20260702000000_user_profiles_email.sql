-- ---------------------------------------------------------------------------
-- Mirror each user's login email onto public.user_profiles.
-- ---------------------------------------------------------------------------
-- Sharing and user-lookup used to walk auth.users (auth.admin.listUsers) to map
-- an email to a user_id and back. That scan is O(all users) per request and
-- reaches into the auth schema from application code. Mirroring the email onto
-- the profile row lets every lookup / people / share-gate query hit
-- public.user_profiles directly (indexed), and never touch auth.users.
--
-- Additive + idempotent: adds a nullable column, two indexes, and extends the
-- existing new-user trigger to also populate the mirror. Nothing is dropped, so
-- rolling this out on a live DB is safe. The runner (apps/api/scripts/migrate.mjs)
-- applies each file in one transaction and strips any begin/commit, so this file
-- carries none.

alter table public.user_profiles
  add column if not exists email text;

-- Case-insensitive uniqueness: one profile per email, ignoring blanks. Emails
-- are stored already-lowercased (see the trigger + syncProfileEmail), but the
-- lower() expression index keeps the guarantee even if a row is written raw.
create unique index if not exists user_profiles_email_lower_unique
  on public.user_profiles (lower(email))
  where email is not null and btrim(email) <> '';

-- Plain lookup index for the equality probes (findProfileUserByEmail,
-- findMissingUserEmails) which query the stored (already-lowercased) value.
create index if not exists idx_user_profiles_email
  on public.user_profiles (email);

-- ---------------------------------------------------------------------------
-- Extend handle_new_user to ALSO mirror the email.
-- ---------------------------------------------------------------------------
-- This is the current body from 20260701000000_organizations_rbac.sql copied
-- verbatim, with two additions only: the insert now writes `email`, and the
-- previously-noop conflict path now upserts the email (so an existing profile
-- created before this migration gets backfilled the first time its owner signs
-- up again / the trigger re-fires). The org-provisioning block and the
-- swallow-errors guard are preserved unchanged.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  insert into public.user_profiles (user_id, email)
  values (new.id, lower(new.email))
  on conflict (user_id) do update
    set email = excluded.email,
        updated_at = now();

  -- Personal organization (one per user, enforced by the partial unique index).
  if not exists (
    select 1 from public.organizations
    where created_by = new.id and personal
  ) then
    insert into public.organizations (name, personal, created_by)
    values (coalesce(new.email, 'Personal'), true, new.id)
    returning id into v_org_id;

    insert into public.org_members (org_id, user_id, role)
    values (v_org_id, new.id, 'owner')
    on conflict (org_id, user_id) do nothing;
  end if;

  return new;
exception when others then
  -- Never block signup if the profile / org insert fails.
  return new;
end;
$$;
