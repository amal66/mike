/**
 * Project / document access helpers.
 *
 * Sharing makes the previous "scope by user_id" pattern incorrect — a doc
 * can belong to user A's project that A has shared with B's email, and B
 * must still be able to read/edit it. These helpers centralize the
 * "creator OR direct grantee OR org member" check so every route uses the
 * same logic instead of re-implementing the join.
 *
 * Access can arrive through three branches, each of which derives a
 * ProjectRole (lib/permissions.ts):
 *   1. creator      — the row's `user_id` matches the caller → "admin".
 *                     The creator is an admin like any other admin; they hold
 *                     no permanently elevated tier above their peers.
 *   2. direct grant — a `project_access_grants` row matching the caller's
 *                     email → that grant's role (admin/member/viewer). The
 *                     recipient needs no org membership and no account yet,
 *                     which is what makes "outside counsel" sharing work on
 *                     an organization's project.
 *   3. org role     — the row's `org_id` is an org the caller belongs to.
 *                     Org admin → project admin, org member → project member.
 *                     Inheritance is computed here, never materialized into
 *                     grant rows, so changing someone's org role immediately
 *                     changes their standing on every project the org owns.
 *
 * When several branches match, the caller gets the STRONGEST derived role
 * (`strongerRole` in lib/permissions.ts): a grant can only ever add standing.
 * A viewer grant handed to an org admin does not demote them, and an admin
 * grant handed to a plain org member does promote them.
 *
 * Personal content is simply `org_id IS NULL` — there is no hidden personal
 * organization. Content without an org is reachable through branches 1 and 2
 * only.
 */

import type { createServerSupabase } from "./supabase";
import {
    can,
    isProjectRole,
    strongerRole,
    type ProjectRole,
} from "./permissions";

export {
    can,
    isProjectRole,
    strongerRole,
    type Capability,
    type ProjectRole,
} from "./permissions";

type Db = ReturnType<typeof createServerSupabase>;

/**
 * Organizations have exactly two roles. Admins administer the organization
 * (members, invitations, settings) and inherit project admin on its projects;
 * members collaborate and inherit project member.
 */
export type OrgRole = "admin" | "member";

export const ORG_ROLES: OrgRole[] = ["admin", "member"];

export function isOrgRole(value: unknown): value is OrgRole {
    return typeof value === "string" && (ORG_ROLES as string[]).includes(value);
}

/** Only org admins may administer an org (members, invitations, settings). */
export function isOrgAdmin(role: OrgRole | null | undefined): boolean {
    return role === "admin";
}

/**
 * What standing in the tenant grants on an org project: the two ladders are
 * deliberately parallel, so "what can this person do here" has one answer
 * that does not depend on which door they came through.
 */
export function orgRoleToProjectRole(role: OrgRole): ProjectRole {
    return role === "admin" ? "admin" : "member";
}

/** Normalize an email the way every grant/invitation row stores it. */
export function normalizeEmail(
    email: string | null | undefined,
): string | null {
    const normalized = (email ?? "").trim().toLowerCase();
    return normalized || null;
}

/**
 * The caller's role in a single org, or null if they are not a member.
 */
export async function getOrgRole(
    userId: string,
    orgId: string | null | undefined,
    db: Db,
): Promise<OrgRole | null> {
    if (!orgId) return null;
    const { data } = await db
        .from("org_members")
        .select("role")
        .eq("org_id", orgId)
        .eq("user_id", userId)
        .maybeSingle();
    const role = (data as { role?: string } | null)?.role;
    return isOrgRole(role) ? role : null;
}

/**
 * Every org id the caller belongs to. Used to scope collection reads and to
 * validate an org_id chosen at create time.
 */
export async function listUserOrgIds(userId: string, db: Db): Promise<string[]> {
    const { data } = await db
        .from("org_members")
        .select("org_id")
        .eq("user_id", userId);
    const ids = new Set<string>();
    for (const row of (data ?? []) as { org_id?: string | null }[]) {
        if (row.org_id) ids.add(row.org_id);
    }
    return [...ids];
}

/**
 * The role a direct access grant gives the caller on a project, or null when
 * they hold no grant. Grants are keyed by normalized email so an invitation
 * to share can be honoured before the recipient has an account.
 */
export async function getProjectGrantRole(
    projectId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<ProjectRole | null> {
    const email = normalizeEmail(userEmail);
    if (!email) return null;
    const { data } = await db
        .from("project_access_grants")
        .select("role")
        .eq("project_id", projectId)
        .eq("email", email)
        .maybeSingle();
    const role = (data as { role?: string } | null)?.role;
    return isProjectRole(role) ? role : null;
}

/**
 * Choose the org_id a newly created resource should carry. Content created
 * inside a project inherits that project's org; everything else is personal
 * (org_id null). There is no personal organization to fall back to — an
 * absent org IS the personal case.
 *
 * Result-shaped because "the lookup failed" and "this is personal" must
 * never share a value. `null` is not a safe default here: it is the very
 * encoding of personal content, and personal content is what account
 * deletion destroys. A swallowed error at this seam filed a firm's upload
 * as its uploader's private property — invisible to org inheritance today,
 * destroyed with the uploader's account later. Callers refuse the request
 * instead of guessing the tenant.
 */
export async function resolveContentOrgId(
    db: Db,
    params: { projectId?: string | null },
): Promise<{ ok: true; orgId: string | null } | { ok: false; detail: string }> {
    if (!params.projectId) return { ok: true, orgId: null };
    const { data, error } = await db
        .from("projects")
        .select("org_id")
        .eq("id", params.projectId)
        .maybeSingle();
    if (error)
        return {
            ok: false,
            detail:
                error.message ?? "Failed to resolve the project's organization",
        };
    return {
        ok: true,
        orgId: (data as { org_id?: string | null } | null)?.org_id ?? null,
    };
}

type ProjectRow = {
    id: string;
    user_id: string | null;
    shared_with: string[] | null;
    org_id?: string | null;
};

export type ProjectAccess =
    | {
          ok: true;
          /** True when the caller created this row ("created by me"), which is
           *  provenance only — it grants no rights beyond the admin role the
           *  creator branch already derives. */
          isCreator: boolean;
          orgRole: OrgRole | null;
          projectRole: ProjectRole;
          project: ProjectRow;
      }
    | { ok: false };

export async function checkProjectAccess(
    projectId: string,
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<ProjectAccess> {
    const { data: project } = await db
        .from("projects")
        .select("id, user_id, shared_with, org_id")
        .eq("id", projectId)
        .maybeSingle();
    if (!project) return { ok: false };
    const proj = project as ProjectRow;

    const isCreator = !!proj.user_id && proj.user_id === userId;
    const orgRole = await getOrgRole(userId, proj.org_id, db);
    const grantRole = await getProjectGrantRole(proj.id, userEmail, db);

    // Merge every branch strongest-wins: an org admin keeps admin even if
    // someone also hands them a viewer grant, and a viewer grant on top of
    // plain org membership never drops the member below member.
    let projectRole = strongerRole(
        isCreator ? "admin" : null,
        orgRole ? orgRoleToProjectRole(orgRole) : null,
    );
    projectRole = strongerRole(projectRole, grantRole);

    if (!projectRole) return { ok: false };
    return { ok: true, isCreator, orgRole, projectRole, project: proj };
}

type ResourceAccess =
    | {
          ok: true;
          isCreator: boolean;
          orgRole: OrgRole | null;
          projectRole: ProjectRole;
      }
    | { ok: false };

/**
 * Some operations stay scoped to the person who made the row — replacing or
 * deleting one version of a document, moving a review between projects.
 * Those rules are about authorship, not tier, and they predate this module.
 *
 * They acquired a hole the moment account deletion started blanking
 * `user_id` instead of destroying an organization's content: a row can now
 * have no creator at all, and "only the creator may act" then means NOBODY
 * may act. The document is stranded inside a project the organization is
 * supposed to control — exactly the outcome detaching the row was meant to
 * prevent. So when the creator is gone, the container's admins inherit the
 * operation. While a creator still exists, nothing changes: an admin does
 * not get to reach into a colleague's versions.
 */
export function creatorScopedAllowed(
    access: { isCreator: boolean; projectRole: ProjectRole },
    creatorId: string | null | undefined,
): boolean {
    if (access.isCreator) return true;
    return !creatorId && can(access.projectRole, "container.delete");
}

/** Build the ResourceAccess for a derived project role. */
function resourceAccessFor(
    projectRole: ProjectRole,
    orgRole: OrgRole | null,
    isCreator: boolean,
): ResourceAccess {
    return { ok: true, isCreator, orgRole, projectRole };
}

/**
 * Check whether the current user can access a document the caller has
 * already loaded (saves a round-trip vs. having the helper re-fetch).
 * The document's own creator is an admin of it; otherwise the project verdict
 * (which already merges its grant and org branches strongest-wins) is merged
 * with a direct org-membership check on the doc's own org_id — covering
 * org-tagged docs outside any project and docs whose org differs from
 * their project's. Merging means the doc-org branch can only upgrade the
 * verdict, never downgrade it. `isCreator` keeps meaning "created this row":
 * a project admin is not the creator of a colleague's document, but inherits
 * the project role for capability checks.
 */
export async function ensureDocAccess(
    doc: {
        user_id: string | null;
        project_id: string | null;
        org_id?: string | null;
        workflow_id?: string | null;
    },
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<ResourceAccess> {
    const isCreator = !!doc.user_id && doc.user_id === userId;
    if (isCreator)
        return { ok: true, isCreator: true, orgRole: null, projectRole: "admin" };
    const access = doc.project_id
        ? await checkProjectAccess(doc.project_id, userId, userEmail, db)
        : ({ ok: false } as const);
    let best: ProjectRole | null = access.ok ? access.projectRole : null;
    let bestOrg: OrgRole | null = access.ok ? access.orgRole : null;
    // Skip the doc-org lookup when the project verdict already folded in
    // this same org's membership.
    if (doc.org_id && (!access.ok || doc.org_id !== access.project.org_id)) {
        const docRole = await getOrgRole(userId, doc.org_id, db);
        if (docRole) {
            const viaDocOrg = orgRoleToProjectRole(docRole);
            if (strongerRole(best, viaDocOrg) !== best) {
                best = viaDocOrg;
                bestOrg = docRole;
            }
        }
    }
    if (doc.workflow_id) {
        const normalizedEmail = (userEmail ?? "").trim().toLowerCase();
        if (normalizedEmail) {
            const { data: share } = await db
                .from("workflow_shares")
                .select("allow_edit")
                .eq("workflow_id", doc.workflow_id)
                .eq("shared_with_email", normalizedEmail)
                .maybeSingle();
            if (share) {
                const viaWorkflow: ProjectRole =
                    share.allow_edit === true ? "member" : "viewer";
                if (strongerRole(best, viaWorkflow) !== best)
                    best = viaWorkflow;
            }
        }
    }
    if (!best) return { ok: false };
    return resourceAccessFor(best, bestOrg, false);
}

/**
 * The standing a shared row confers ON ITS OWN, before any container is
 * consulted: its creator is its admin, and an email on its `shared_with` is a
 * member. Both branches are decided from the row and the caller alone, so
 * this needs no database round-trip.
 *
 * Split out for two callers. `ensureSharedRowAccess` below uses it for those
 * two branches. A LIST endpoint uses it to label every row it returns with
 * the caller's role, having resolved the shared container once instead of per
 * row — the per-row alternative is an N+1 of `checkProjectAccess` calls, and
 * hand-writing the "creator or share list" test at the list site is how the
 * list and the detail route drift apart, which is the class of bug this PR
 * exists to remove.
 */
export function sharedRowOwnRole(
    row: { user_id?: string | null; shared_with?: string[] | null },
    userId: string,
    userEmail: string | null | undefined,
): { isCreator: boolean; role: ProjectRole | null } {
    if (row.user_id && row.user_id === userId)
        return { isCreator: true, role: "admin" };
    const email = normalizeEmail(userEmail);
    const directShare =
        !!email &&
        Array.isArray(row.shared_with) &&
        row.shared_with.some((e) => (e ?? "").toLowerCase() === email);
    return { isCreator: false, role: directShare ? "member" : null };
}

/**
 * Shared derivation for the content rows that carry the full sharing shape
 * (`user_id`, `project_id`, `shared_with`, `org_id`) — today tabular reviews
 * and assistant chats. A row can be reached in four ways:
 *   1. Creator — the row's `user_id` is the caller → "admin".
 *   2. Directly — the row's own `shared_with` email list, so a standalone
 *      row (project_id null) can be shared without a project. Those
 *      collaborators are members: content collaboration, not administration.
 *   3. Indirectly — if `project_id` is set, everyone with project access
 *      can read/operate on it at their project role.
 *   4. Org — the row's `org_id` is an org the caller belongs to.
 */
async function ensureSharedRowAccess(
    row: {
        user_id: string | null;
        project_id: string | null;
        shared_with?: string[] | null;
        org_id?: string | null;
    },
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<ResourceAccess> {
    const own = sharedRowOwnRole(row, userId, userEmail);
    if (own.isCreator)
        return { ok: true, isCreator: true, orgRole: null, projectRole: "admin" };
    // Merge all branches strongest-wins. The direct share is a floor, not a
    // ceiling: it must not shadow a stronger standing coming from the
    // project (its admins) — being added to a row's share list must never
    // demote a project admin to member.
    const access = row.project_id
        ? await checkProjectAccess(row.project_id, userId, userEmail, db)
        : ({ ok: false } as const);
    let best: ProjectRole | null = own.role;
    let bestOrg: OrgRole | null = null;
    // On a tie the project verdict wins so the org `orgRole` field survives.
    if (
        access.ok &&
        strongerRole(access.projectRole, best) === access.projectRole
    ) {
        best = access.projectRole;
        bestOrg = access.orgRole;
    }
    // Skip the row-org lookup when the project verdict already folded in
    // this same org's membership.
    if (row.org_id && (!access.ok || row.org_id !== access.project.org_id)) {
        const rowOrgRole = await getOrgRole(userId, row.org_id, db);
        if (rowOrgRole) {
            const viaOrg = orgRoleToProjectRole(rowOrgRole);
            if (strongerRole(best, viaOrg) !== best) {
                best = viaOrg;
                bestOrg = rowOrgRole;
            }
        }
    }
    if (!best) return { ok: false };
    return resourceAccessFor(best, bestOrg, false);
}

/**
 * Same shape as `ensureDocAccess`, for tabular_reviews: creator, direct
 * `shared_with` email, project access, or review-org membership — merged
 * strongest-wins (see `ensureSharedRowAccess`). The review's creator is
 * always an admin of it.
 */
export async function ensureReviewAccess(
    review: {
        user_id: string | null;
        project_id: string | null;
        shared_with?: string[] | null;
        org_id?: string | null;
    },
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<ResourceAccess> {
    return ensureSharedRowAccess(review, userId, userEmail, db);
}

/**
 * Same shape as `ensureReviewAccess`, for assistant chats — chats carry the
 * identical sharing columns since 20260902_04. A project chat inherits the
 * project verdict; a standalone chat can be shared through its own
 * `shared_with`, and is personal (org_id null) until it is.
 *
 * `get_chats_overview` mirrors this predicate branch for branch — keep the
 * two in lockstep, or a chat becomes openable by URL while staying invisible
 * in the list.
 */
export async function ensureChatAccess(
    chat: {
        user_id: string | null;
        project_id: string | null;
        shared_with?: string[] | null;
        org_id?: string | null;
    },
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<ResourceAccess> {
    return ensureSharedRowAccess(chat, userId, userEmail, db);
}

/**
 * Filter user-supplied document IDs down to documents the caller can read.
 *
 * Tabular review routes accept document IDs from request bodies. Without this
 * check, a caller with access to any review could attach arbitrary document
 * UUIDs and later cause /generate or /regenerate-cell to extract those bytes.
 */
export async function filterAccessibleDocumentIds(
    documentIds: string[],
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<string[]> {
    if (documentIds.length === 0) return [];
    const { data: docs } = await db
        .from("documents")
        .select("id, user_id, project_id, org_id")
        .in("id", documentIds);
    const rows = (docs ?? []) as {
        id: string;
        user_id: string | null;
        project_id: string | null;
        org_id?: string | null;
    }[];
    if (rows.length === 0) return [];

    const [accessibleProjectIds, userOrgIds] = await Promise.all([
        listAccessibleProjectIds(userId, userEmail, db).then(
            (ids) => new Set(ids),
        ),
        listUserOrgIds(userId, db).then((ids) => new Set(ids)),
    ]);
    const allowed: string[] = [];
    for (const doc of rows) {
        if (doc.user_id && doc.user_id === userId) {
            allowed.push(doc.id);
        } else if (doc.org_id && userOrgIds.has(doc.org_id)) {
            allowed.push(doc.id);
        } else if (doc.project_id && accessibleProjectIds.has(doc.project_id)) {
            allowed.push(doc.id);
        }
    }
    return allowed;
}

/**
 * Returns the set of project IDs the user can access — projects they created,
 * any project they hold an access grant on, and any project in an org they
 * belong to. Used to scope chat lists and similar collection queries.
 */
export async function listAccessibleProjectIds(
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<string[]> {
    const normalizedEmail = normalizeEmail(userEmail);
    const orgIds = await listUserOrgIds(userId, db);
    const [{ data: own }, { data: granted }, { data: orgProjects }] =
        await Promise.all([
            db.from("projects").select("id").eq("user_id", userId),
            normalizedEmail
                ? db
                      .from("project_access_grants")
                      .select("project_id")
                      .eq("email", normalizedEmail)
                : Promise.resolve({ data: [] as { project_id: string }[] }),
            orgIds.length > 0
                ? db.from("projects").select("id").in("org_id", orgIds)
                : Promise.resolve({ data: [] as { id: string }[] }),
        ]);
    const ids = new Set<string>();
    for (const p of (own ?? []) as { id: string }[]) ids.add(p.id);
    for (const g of (granted ?? []) as { project_id?: string | null }[]) {
        if (g.project_id) ids.add(g.project_id);
    }
    for (const p of (orgProjects ?? []) as { id: string }[]) ids.add(p.id);
    return [...ids];
}
