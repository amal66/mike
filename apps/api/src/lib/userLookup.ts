/**
 * Email-based user lookup, backed entirely by the public.user_profiles.email
 * mirror (see supabase migration 20260702000000_user_profiles_email.sql).
 *
 * Previously the /people endpoints and the share flow resolved emails through
 * `auth.admin.listUsers({ perPage: 1000 })` — a full scan of the auth schema on
 * every request. Every helper here queries the mirrored `email` column on
 * user_profiles instead: it is indexed, it never reaches into auth.users, and
 * it scales with the number of shared members rather than the whole tenant.
 *
 * The mirror is kept fresh from two sides:
 *   - the handle_new_user trigger writes it at signup, and
 *   - syncProfileEmail() below re-asserts it on every authenticated request
 *     (called from requireAuth), so pre-existing profiles are backfilled the
 *     first time their owner makes a request after this ships.
 */

import type { createServerSupabase } from "./supabase";

// The admin/server Supabase client is untyped (`any`) in this codebase; alias it
// so the intent ("a db handle") is explicit at every call site.
type Db = ReturnType<typeof createServerSupabase>;

export type ProfileUser = {
  user_id: string;
  email: string;
  display_name: string | null;
};

function normalizeEmail(email: string | null | undefined): string {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

/**
 * Mirror a user's login email onto their profile row. Called on every
 * authenticated request (requireAuth), so it must be cheap and must NEVER
 * throw — a mirror failure can't be allowed to block the request. Returns the
 * error (for opportunistic logging) instead of raising, or null on success /
 * when there is nothing to write.
 */
export async function syncProfileEmail(
  admin: Db,
  userId: string,
  email: string | null | undefined,
): Promise<Error | null> {
  try {
    const normalized = normalizeEmail(email);
    if (!userId || !normalized) return null;
    const { error } = await admin
      .from("user_profiles")
      .upsert(
        { user_id: userId, email: normalized },
        { onConflict: "user_id" },
      );
    return error ? new Error(error.message) : null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Resolve a single email to its profile (email + display_name), or null when
 * no Mike user owns that email. Backs GET /user/lookup.
 */
export async function findProfileUserByEmail(
  db: Db,
  email: string,
): Promise<{ email: string; display_name: string | null } | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const { data } = await db
    .from("user_profiles")
    .select("email, display_name")
    .eq("email", normalized)
    .maybeSingle();
  if (!data) return null;
  return {
    email: (data.email as string | null) ?? normalized,
    display_name: (data.display_name as string | null) ?? null,
  };
}

/**
 * Given a list of emails, return the subset that does NOT belong to any Mike
 * user. Order is preserved (deduped, normalized) so callers can surface the
 * first offender. Backs the share-gate below.
 */
export async function findMissingUserEmails(
  db: Db,
  emails: string[],
): Promise<string[]> {
  const normalized = [
    ...new Set((emails ?? []).map(normalizeEmail).filter(Boolean)),
  ];
  if (normalized.length === 0) return [];
  const { data } = await db
    .from("user_profiles")
    .select("email")
    .in("email", normalized);
  const found = new Set(
    ((data ?? []) as { email: string | null }[])
      .map((row) => normalizeEmail(row.email))
      .filter(Boolean),
  );
  return normalized.filter((email) => !found.has(email));
}

/**
 * Load every profile that has a mirrored email, indexed both by email and by
 * user_id. The /people endpoints use this to turn an owner's user_id and a
 * project's shared_with emails into {email, display_name} without scanning
 * auth.users.
 */
export async function loadProfileUsersByEmail(db: Db): Promise<{
  userByEmail: Map<string, ProfileUser>;
  userById: Map<string, ProfileUser>;
}> {
  const { data } = await db
    .from("user_profiles")
    .select("user_id, email, display_name");
  const userByEmail = new Map<string, ProfileUser>();
  const userById = new Map<string, ProfileUser>();
  for (const row of (data ?? []) as {
    user_id: string;
    email: string | null;
    display_name: string | null;
  }[]) {
    const email = normalizeEmail(row.email);
    if (!email) continue;
    const user: ProfileUser = {
      user_id: row.user_id,
      email,
      display_name: row.display_name ?? null,
    };
    userByEmail.set(email, user);
    userById.set(row.user_id, user);
  }
  return { userByEmail, userById };
}

// ---------------------------------------------------------------------------
// Share-gating (BEHAVIOR CHANGE)
// ---------------------------------------------------------------------------
// Sharing a project / tabular review / workflow with an email that does not
// belong to an existing Mike user is now REJECTED with a 400. Previously any
// email could be added to shared_with and simply never resolved to a user.
//
// TOGGLE POINT: this single flag turns the gate off everywhere at once. Set
// MIKE_SHARE_GATING=off (env) to restore the old permissive behavior without
// touching call sites.
export const SHARE_GATING_ENABLED = process.env.MIKE_SHARE_GATING !== "off";

/**
 * The one guard every share write funnels through. Returns ok when every email
 * belongs to a Mike user (or the gate is disabled), otherwise the detail string
 * for the FIRST offending email — the exact copy the routes return verbatim.
 */
export async function assertShareableEmails(
  db: Db,
  emails: string[],
): Promise<{ ok: true } | { ok: false; detail: string }> {
  if (!SHARE_GATING_ENABLED) return { ok: true };
  const missing = await findMissingUserEmails(db, emails);
  if (missing.length > 0) {
    return {
      ok: false,
      detail: `${missing[0]} does not belong to a Mike user.`,
    };
  }
  return { ok: true };
}
