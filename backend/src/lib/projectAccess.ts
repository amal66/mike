// Direct (non-organization) access grants on a project.
//
// The original model was `projects.shared_with`, a jsonb array of emails. It
// could express WHO but never WHAT: every collaborator got the same rights,
// so "let outside counsel read this" and "let a colleague restructure it"
// were the same operation. `project_access_grants` replaces it with one row
// per recipient carrying an explicit project role.
//
// Two properties are load-bearing:
//
//   * Grants are keyed by normalized email, not user id, so a project can be
//     shared with somebody who has no account yet (they pick the grant up on
//     signup) and — crucially for Will's "outside counsel" case — with
//     somebody who is not a member of the project's organization.
//   * Grants are additive. lib/access.ts merges the grant with any org
//     inheritance strongest-wins, so handing an org admin a viewer grant does
//     not demote them.
//
// `projects.shared_with` survives as a DERIVED MIRROR of the grant emails.
// The column is still read by the web UI (frontend/src/app/.../PeopleModal and
// the project types), which this backend-only PR does not revise; keeping it
// in sync means the un-revised UI keeps listing collaborators correctly while
// every authorization decision reads the grants. When the UI PR lands the
// mirror — and the column — can go.

import type { createServerSupabase } from "./supabase";
import { normalizeEmail } from "./access";
import { isProjectRole, type ProjectRole } from "./permissions";

type Db = ReturnType<typeof createServerSupabase>;

export type ProjectGrant = {
    id: string;
    project_id: string;
    email: string;
    role: ProjectRole;
    created_by: string | null;
    created_at: string;
    updated_at: string;
};

export async function listProjectGrants(
    db: Db,
    projectId: string,
): Promise<ProjectGrant[]> {
    const { data } = await db
        .from("project_access_grants")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: true });
    return (data ?? []) as ProjectGrant[];
}

/**
 * Rewrite `projects.shared_with` from the grant table so the two never drift.
 * Called after every grant mutation.
 *
 * A failure here does NOT fail the caller. The grant table is the source of
 * truth and it has already been written; refusing the whole operation because
 * a display column could not be refreshed would turn a cosmetic problem into
 * a functional one, and the retry would replay a mutation that already
 * succeeded. But it is not nothing either — the one state this design has to
 * be able to notice is "the mirror is stale" — so it is logged loudly, with
 * the SQLSTATE and message only rather than the raw error object: Postgres
 * error payloads carry `details`/`hint` strings that quote the offending row,
 * and these rows are email addresses.
 */
export async function syncSharedWithMirror(
    db: Db,
    projectId: string,
): Promise<string[]> {
    const grants = await listProjectGrants(db, projectId);
    const emails = grants.map((g) => g.email);
    const { error } = await db
        .from("projects")
        .update({ shared_with: emails })
        .eq("id", projectId);
    if (error) {
        console.error("[project-access] shared_with mirror is now stale", {
            projectId,
            code: (error as { code?: string }).code ?? null,
            message: error.message,
        });
    }
    return emails;
}

export type GrantWriteResult =
    | { ok: true; grant: ProjectGrant }
    | { ok: false; kind: "validation"; detail: string }
    | { ok: false; kind: "db_error"; detail: string };

/**
 * Create or re-role one recipient. Upsert rather than insert-or-409: sharing
 * again with a different role is the natural way a user changes someone's
 * access, and making that a conflict would force the UI to guess which verb
 * to send.
 */
export async function upsertProjectGrant(
    db: Db,
    params: {
        projectId: string;
        email: unknown;
        role: unknown;
        createdBy: string;
        /** Emails belonging to the project's creator can't be granted away. */
        creatorEmail?: string | null;
    },
): Promise<GrantWriteResult> {
    const email =
        typeof params.email === "string" ? normalizeEmail(params.email) : null;
    if (!email || !email.includes("@"))
        return {
            ok: false,
            kind: "validation",
            detail: "A valid email address is required",
        };
    if (!isProjectRole(params.role))
        return {
            ok: false,
            kind: "validation",
            detail: "role must be admin, member or viewer",
        };
    const creatorEmail = normalizeEmail(params.creatorEmail);
    if (creatorEmail && creatorEmail === email)
        return {
            ok: false,
            kind: "validation",
            detail: "The project creator already has admin access",
        };

    const { data, error } = await db
        .from("project_access_grants")
        .upsert(
            {
                project_id: params.projectId,
                email,
                role: params.role,
                created_by: params.createdBy,
                updated_at: new Date().toISOString(),
            },
            { onConflict: "project_id,email" },
        )
        .select("*")
        .single();
    if (error || !data)
        return {
            ok: false,
            kind: "db_error",
            detail: error?.message ?? "Failed to save access grant",
        };
    await syncSharedWithMirror(db, params.projectId);
    return { ok: true, grant: data as ProjectGrant };
}

export async function deleteProjectGrant(
    db: Db,
    params: { projectId: string; email: string },
): Promise<{ ok: true; removed: boolean } | { ok: false; detail: string }> {
    const email = normalizeEmail(params.email);
    if (!email) return { ok: true, removed: false };
    const { data, error } = await db
        .from("project_access_grants")
        .delete()
        .eq("project_id", params.projectId)
        .eq("email", email)
        .select("id");
    if (error) return { ok: false, detail: error.message };
    await syncSharedWithMirror(db, params.projectId);
    return { ok: true, removed: ((data ?? []) as unknown[]).length > 0 };
}

/**
 * Legacy path: PATCH /projects/:id still accepts a roleless `shared_with`
 * array. Treat it as the SET of people with direct access — emails that are
 * already granted keep whatever role they hold (so a roleless client can
 * never silently demote an admin collaborator), newcomers land on 'member',
 * and anyone dropped from the array loses their grant.
 */
export async function replaceGrantsFromEmails(
    db: Db,
    params: { projectId: string; emails: string[]; createdBy: string },
): Promise<{ ok: true; emails: string[] } | { ok: false; detail: string }> {
    const wanted = new Set<string>();
    for (const raw of params.emails) {
        const email = normalizeEmail(raw);
        if (email) wanted.add(email);
    }
    const existing = await listProjectGrants(db, params.projectId);
    const existingByEmail = new Map(existing.map((g) => [g.email, g]));

    const removals = existing
        .filter((g) => !wanted.has(g.email))
        .map((g) => g.id);
    if (removals.length > 0) {
        const { error } = await db
            .from("project_access_grants")
            .delete()
            .in("id", removals);
        if (error) return { ok: false, detail: error.message };
    }

    const additions = [...wanted]
        .filter((email) => !existingByEmail.has(email))
        .map((email) => ({
            project_id: params.projectId,
            email,
            role: "member" as ProjectRole,
            created_by: params.createdBy,
        }));
    if (additions.length > 0) {
        const { error } = await db
            .from("project_access_grants")
            .upsert(additions, { onConflict: "project_id,email" });
        if (error) return { ok: false, detail: error.message };
    }

    const emails = await syncSharedWithMirror(db, params.projectId);
    return { ok: true, emails };
}

export type ProjectContact = {
    user_id: string | null;
    email: string | null;
    display_name: string | null;
    /** How this person got admin: 'creator', 'grant' or 'organization'. */
    source: "creator" | "grant" | "organization";
};

/**
 * Everyone who can administer this project, with an address to contact them.
 *
 * The UI needs this to answer "you can't do that — ask who?" A permission
 * popup that has no name to offer is a dead end, and the previous shape made
 * that unavoidable: GET /projects/:id returned no contact at all, and the
 * overview RPC's owner_email column is a literal NULL, so the popup's email
 * line could never render.
 *
 * The creator is listed first (they are the most likely point of contact),
 * followed by direct admin grants and then the org's admins.
 */
export async function listProjectAdminContacts(
    db: Db,
    project: { id: string; user_id: string | null; org_id?: string | null },
): Promise<ProjectContact[]> {
    const contacts: ProjectContact[] = [];
    const seenEmails = new Set<string>();
    const push = (contact: ProjectContact) => {
        const key = contact.email ?? `id:${contact.user_id}`;
        if (!key || seenEmails.has(key)) return;
        seenEmails.add(key);
        contacts.push(contact);
    };

    const profileIds: string[] = [];
    if (project.user_id) profileIds.push(project.user_id);

    const grants = await listProjectGrants(db, project.id);
    const adminGrantEmails = grants
        .filter((g) => g.role === "admin")
        .map((g) => g.email);

    let orgAdminIds: string[] = [];
    if (project.org_id) {
        const { data } = await db
            .from("org_members")
            .select("user_id")
            .eq("org_id", project.org_id)
            .eq("role", "admin");
        orgAdminIds = ((data ?? []) as { user_id?: string | null }[])
            .map((r) => r.user_id)
            .filter((id): id is string => !!id);
        profileIds.push(...orgAdminIds);
    }

    const byUserId = new Map<
        string,
        { email: string | null; display_name: string | null }
    >();
    const byEmail = new Map<
        string,
        { user_id: string; display_name: string | null }
    >();
    if (profileIds.length > 0) {
        const { data } = await db
            .from("user_profiles")
            .select("user_id, email, display_name")
            .in("user_id", [...new Set(profileIds)]);
        for (const p of (data ?? []) as {
            user_id: string;
            email: string | null;
            display_name: string | null;
        }[]) {
            byUserId.set(p.user_id, {
                email: p.email ?? null,
                display_name: p.display_name ?? null,
            });
        }
    }
    if (adminGrantEmails.length > 0) {
        const { data } = await db
            .from("user_profiles")
            .select("user_id, email, display_name")
            .in("email", adminGrantEmails);
        for (const p of (data ?? []) as {
            user_id: string;
            email: string | null;
            display_name: string | null;
        }[]) {
            if (p.email) byEmail.set(p.email, {
                user_id: p.user_id,
                display_name: p.display_name ?? null,
            });
        }
    }

    if (project.user_id) {
        const profile = byUserId.get(project.user_id);
        push({
            user_id: project.user_id,
            email: profile?.email ?? null,
            display_name: profile?.display_name ?? null,
            source: "creator",
        });
    }
    for (const email of adminGrantEmails) {
        const profile = byEmail.get(email);
        push({
            user_id: profile?.user_id ?? null,
            email,
            display_name: profile?.display_name ?? null,
            source: "grant",
        });
    }
    for (const adminId of orgAdminIds) {
        const profile = byUserId.get(adminId);
        push({
            user_id: adminId,
            email: profile?.email ?? null,
            display_name: profile?.display_name ?? null,
            source: "organization",
        });
    }
    return contacts;
}

/** Drop every grant addressed to one person (account deletion). */
export async function removeGrantsForEmail(
    db: Db,
    email: string | null | undefined,
): Promise<void> {
    const normalized = normalizeEmail(email);
    if (!normalized) return;
    const { data } = await db
        .from("project_access_grants")
        .delete()
        .eq("email", normalized)
        .select("project_id");
    const projectIds = [
        ...new Set(
            ((data ?? []) as { project_id?: string | null }[])
                .map((r) => r.project_id)
                .filter((id): id is string => !!id),
        ),
    ];
    for (const projectId of projectIds) {
        await syncSharedWithMirror(db, projectId);
    }
}
