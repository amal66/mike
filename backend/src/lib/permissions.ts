/**
 * Project-scoped roles and the capability matrix.
 *
 * Every access decision reduces to: derive the caller's ProjectRole for the
 * container (lib/access.ts), then ask `can(role, capability)` here. Routes
 * never compare roles or re-derive rights from an ownership flag — they
 * declare the capability they need, so the policy lives in exactly one table.
 *
 * The ladder (each tier includes everything below it):
 *
 *   role     | granted to
 *   ---------|------------------------------------------------------------
 *   viewer   | a direct 'viewer' access grant
 *   member   | a direct 'member' grant, or an org member of the project's org
 *   admin    | a direct 'admin' grant (the creator gets one automatically),
 *            | or an org admin of the project's org
 *
 *   capability     | min role | covers
 *   ---------------|----------|----------------------------------------------
 *   project.view   | viewer   | read docs/chats/reviews, download, watch
 *                  |          | generation streams
 *   content.edit   | member   | upload documents, push versions, chat,
 *                  |          | accept/reject edits, run extractions, reshape
 *                  |          | a review's columns/document set
 *   docs.organize  | member   | rename/move documents AND create/rename/move/
 *                  |          | delete folders
 *   access.manage  | admin    | project settings, sharing and access grants
 *   container.delete | admin  | delete the project/review itself
 *
 * There is deliberately no tier between member and admin. An earlier draft of
 * this module split collaboration into "editor" (content) and "manager"
 * (structure), which forced every folder rename through an elevated role and
 * left the product with four project tiers to explain. Legal teams do not
 * need that distinction: a member who may upload and delete documents is not
 * meaningfully restrained by being unable to rename the folder holding them.
 * So `docs.organize` sits at member alongside `content.edit`, and the only
 * narrow tier is admin — the powers that change WHO can reach the project, or
 * destroy the container outright.
 */

export type ProjectRole = "admin" | "member" | "viewer";

/** The role values a direct access grant may carry (the whole ladder). */
export const PROJECT_ROLES: ProjectRole[] = ["admin", "member", "viewer"];

export function isProjectRole(value: unknown): value is ProjectRole {
    return (
        typeof value === "string" &&
        (PROJECT_ROLES as string[]).includes(value)
    );
}

export type Capability =
    | "project.view"
    | "content.edit"
    | "docs.organize"
    | "access.manage"
    | "container.delete";

const ROLE_RANK: Record<ProjectRole, number> = {
    viewer: 0,
    member: 1,
    admin: 2,
};

const REQUIRED_RANK: Record<Capability, number> = {
    "project.view": ROLE_RANK.viewer,
    "content.edit": ROLE_RANK.member,
    "docs.organize": ROLE_RANK.member,
    "access.manage": ROLE_RANK.admin,
    "container.delete": ROLE_RANK.admin,
};

/**
 * The stronger of two roles; null loses to any role. Access branches merge
 * through this so overlapping grants (say, an explicit share on top of org
 * membership) can only ever add standing, never subtract it.
 */
export function strongerRole(
    a: ProjectRole | null,
    b: ProjectRole | null,
): ProjectRole | null {
    if (!a) return b;
    if (!b) return a;
    return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

/** Fail closed: an absent/unknown role can do nothing. */
export function can(
    role: ProjectRole | null | undefined,
    capability: Capability,
): boolean {
    if (!role || !(role in ROLE_RANK)) return false;
    return ROLE_RANK[role] >= REQUIRED_RANK[capability];
}
