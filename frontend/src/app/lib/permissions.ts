// Client-side mirror of backend/src/lib/permissions.ts — the project role
// ladder and capability matrix. The server is the enforcement point; this
// exists so the UI can hide or disable affordances the server would reject,
// instead of offering actions that fail.
//
// There are exactly three project roles and exactly two organization roles,
// and they are the same words the user sees. An earlier draft of this file
// carried a four-tier project ladder (owner/manager/editor/viewer) that had to
// be translated into different words again for organizations (owner/admin/
// member); nothing in the product needed the extra tiers, and the translation
// was the reason a viewer could be told "manager-only action" about a project
// whose managers were called something else on the settings page.

export type ProjectRole = "admin" | "member" | "viewer";

/** Every project role, strongest first — the order role pickers render in. */
export const PROJECT_ROLES: ProjectRole[] = ["admin", "member", "viewer"];

export type OrgRole = "admin" | "member";

/** Every organization role, strongest first. */
export const ORG_ROLES: OrgRole[] = ["admin", "member"];

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
    // Organizing folders sits with editing content, not above it: a member who
    // may upload and delete documents is not meaningfully restrained by being
    // unable to rename the folder holding them.
    "docs.organize": ROLE_RANK.member,
    "access.manage": ROLE_RANK.admin,
    "container.delete": ROLE_RANK.admin,
};

/** Fail closed: an absent/unknown role can do nothing. */
export function can(
    role: ProjectRole | null | undefined,
    capability: Capability,
): boolean {
    if (!role || !(role in ROLE_RANK)) return false;
    return ROLE_RANK[role] >= REQUIRED_RANK[capability];
}

/** The stronger of two roles; null loses to any role. */
export function strongerRole(
    a: ProjectRole | null | undefined,
    b: ProjectRole | null | undefined,
): ProjectRole | null {
    if (!a || !(a in ROLE_RANK)) return b && b in ROLE_RANK ? b : null;
    if (!b || !(b in ROLE_RANK)) return a;
    return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

export function isProjectRole(value: unknown): value is ProjectRole {
    return typeof value === "string" && value in ROLE_RANK;
}

export function isOrgRole(value: unknown): value is OrgRole {
    return value === "admin" || value === "member";
}

/**
 * Resolve a role from an API row.
 *
 * Both detail endpoints and the list RPCs now return `access_role`, already
 * merged strongest-wins across the creator, direct-grant and organization
 * branches, so that field is always preferred. `is_owner` survives only as
 * provenance ("created by me") for older payloads: true means the creator,
 * who always holds an admin grant, and false means "reached this row some
 * other way" — which is at least member, the tier a roleless legacy share
 * conferred.
 *
 * A row carrying NEITHER field is not a detail or list payload — it's a bare
 * mutation response (PATCH handlers return the raw DB row). Guessing "admin"
 * there would silently open every client gate, so it resolves viewer: fail
 * closed, like `can` does for unknown roles.
 */
export function roleFrom(row: {
    access_role?: ProjectRole | string | null;
    is_owner?: boolean | null;
}): ProjectRole {
    if (isProjectRole(row.access_role)) return row.access_role;
    if (row.is_owner === false) return "member";
    if (row.is_owner === true) return "admin";
    return "viewer";
}

// ---------------------------------------------------------------------------
// The words the user reads
// ---------------------------------------------------------------------------
//
// Role labels and descriptions live here rather than in each surface so the
// settings page, the share dialog and the permission-denied popup cannot
// drift into describing the same role three different ways.

export const PROJECT_ROLE_LABELS: Record<ProjectRole, string> = {
    admin: "Admin",
    member: "Member",
    viewer: "Viewer",
};

export const PROJECT_ROLE_DESCRIPTIONS: Record<ProjectRole, string> = {
    admin: "Everything a member can do, plus project settings, sharing, access management and deleting the project.",
    member: "Edit content, upload documents, use chats and reviews, and organize documents and folders.",
    viewer: "Read-only.",
};

export const ORG_ROLE_LABELS: Record<OrgRole, string> = {
    admin: "Admin",
    member: "Member",
};

export const ORG_ROLE_DESCRIPTIONS: Record<OrgRole, string> = {
    admin: "Manages the organization's people and settings, and administers its projects as a project admin.",
    member: "Collaborates on the organization's projects as a project member.",
};
