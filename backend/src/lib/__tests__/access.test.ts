import { describe, expect, it } from "vitest";
import {
    checkProjectAccess,
    ensureDocAccess,
    ensureReviewAccess,
    filterAccessibleDocumentIds,
    listAccessibleProjectIds,
    orgRoleToProjectRole,
    resolveContentOrgId,
} from "../access";

type Row = Record<string, unknown>;

function makeDb(tables: Record<string, Row[]>) {
    return {
        from(table: string) {
            let rows = [...(tables[table] ?? [])];
            const query = {
                select: () => query,
                order: () => query,
                limit: (n: number) => {
                    rows = rows.slice(0, n);
                    return query;
                },
                eq: (column: string, value: unknown) => {
                    rows = rows.filter((row) => row[column] === value);
                    return query;
                },
                neq: (column: string, value: unknown) => {
                    rows = rows.filter((row) => row[column] !== value);
                    return query;
                },
                in: (column: string, values: unknown[]) => {
                    rows = rows.filter((row) => values.includes(row[column]));
                    return query;
                },
                filter: (column: string, operator: string, value: string) => {
                    if (operator !== "cs") return query;
                    const expected = JSON.parse(value) as string[];
                    rows = rows.filter((row) => {
                        const actual = row[column];
                        return (
                            Array.isArray(actual) &&
                            expected.every((item) => actual.includes(item))
                        );
                    });
                    return query;
                },
                single: async () => ({ data: rows[0] ?? null, error: null }),
                maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
                then: (
                    resolve: (value: { data: Row[]; error: null }) => unknown,
                    reject?: (reason: unknown) => unknown,
                ) =>
                    Promise.resolve({ data: rows, error: null }).then(
                        resolve,
                        reject,
                    ),
            };
            return query;
        },
    } as any;
}

describe("access helpers", () => {
    const db = makeDb({
        projects: [
            { id: "own-project", user_id: "owner", org_id: null },
            { id: "granted-project", user_id: "other-owner", org_id: null },
            { id: "private-project", user_id: "other-owner", org_id: null },
        ],
        project_access_grants: [
            {
                project_id: "granted-project",
                email: "reviewer@example.com",
                role: "member",
            },
        ],
        documents: [
            { id: "own-doc", user_id: "owner", project_id: null },
            {
                id: "granted-doc",
                user_id: "other-owner",
                project_id: "granted-project",
            },
            {
                id: "private-doc",
                user_id: "other-owner",
                project_id: "private-project",
            },
        ],
        workflow_shares: [
            {
                workflow_id: "shared-workflow",
                shared_with_email: "reviewer@example.com",
                allow_edit: false,
            },
            {
                workflow_id: "editable-workflow",
                shared_with_email: "reviewer@example.com",
                allow_edit: true,
            },
        ],
    });

    it("makes the project's creator an admin", async () => {
        const access = await checkProjectAccess(
            "own-project",
            "owner",
            "owner@example.com",
            db,
        );
        expect(access).toMatchObject({
            ok: true,
            isCreator: true,
            projectRole: "admin",
        });
    });

    it("gives a direct grantee exactly the role they were granted", async () => {
        const access = await checkProjectAccess(
            "granted-project",
            "reviewer",
            "reviewer@example.com",
            db,
        );
        expect(access).toMatchObject({
            ok: true,
            isCreator: false,
            projectRole: "member",
        });
    });

    it("matches grant emails case-insensitively", async () => {
        const access = await checkProjectAccess(
            "granted-project",
            "reviewer",
            "  Reviewer@Example.com ",
            db,
        );
        expect(access.ok).toBe(true);
    });

    it("denies a project the caller has no route into", async () => {
        await expect(
            checkProjectAccess(
                "private-project",
                "reviewer",
                "reviewer@example.com",
                db,
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("allows document creators and readers of the containing project", async () => {
        await expect(
            ensureDocAccess(
                { user_id: "owner", project_id: null },
                "owner",
                "owner@example.com",
                db,
            ),
        ).resolves.toMatchObject({ ok: true, projectRole: "admin" });
        await expect(
            ensureDocAccess(
                { user_id: "other-owner", project_id: "granted-project" },
                "reviewer",
                "reviewer@example.com",
                db,
            ),
        ).resolves.toMatchObject({ ok: true, projectRole: "member" });
        await expect(
            ensureDocAccess(
                { user_id: "other-owner", project_id: "private-project" },
                "reviewer",
                "reviewer@example.com",
                db,
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("applies workflow share edit permissions to workflow assets", async () => {
        await expect(
            ensureDocAccess(
                {
                    user_id: "other-owner",
                    project_id: null,
                    workflow_id: "shared-workflow",
                },
                "reviewer",
                " REVIEWER@EXAMPLE.COM ",
                db,
            ),
        ).resolves.toMatchObject({ ok: true, projectRole: "viewer" });
        await expect(
            ensureDocAccess(
                {
                    user_id: "other-owner",
                    project_id: null,
                    workflow_id: "editable-workflow",
                },
                "reviewer",
                "reviewer@example.com",
                db,
            ),
        ).resolves.toMatchObject({ ok: true, projectRole: "member" });
    });

    it("allows direct review sharing without project access", async () => {
        await expect(
            ensureReviewAccess(
                {
                    user_id: "other-owner",
                    project_id: null,
                    shared_with: ["Reviewer@Example.com"],
                },
                "reviewer",
                "reviewer@example.com",
                db,
            ),
        ).resolves.toMatchObject({ ok: true, projectRole: "member" });
    });

    it("lists projects reached by creation and by grant", async () => {
        await expect(
            listAccessibleProjectIds("owner", "owner@example.com", db),
        ).resolves.toEqual(["own-project"]);
        await expect(
            listAccessibleProjectIds("reviewer", "reviewer@example.com", db),
        ).resolves.toEqual(["granted-project"]);
    });

    it("filters user-supplied document IDs to accessible documents only", async () => {
        await expect(
            filterAccessibleDocumentIds(
                ["own-doc", "granted-doc", "private-doc"],
                "reviewer",
                "reviewer@example.com",
                db,
            ),
        ).resolves.toEqual(["granted-doc"]);
    });
});

// ---------------------------------------------------------------------------
// Organization inheritance
// ---------------------------------------------------------------------------

describe("org role inheritance", () => {
    // The two ladders are parallel by design: what you can do on an org
    // project should not depend on which door you came through.
    it("maps org admin to project admin and org member to project member", () => {
        expect(orgRoleToProjectRole("admin")).toBe("admin");
        expect(orgRoleToProjectRole("member")).toBe("member");
    });

    const db = makeDb({
        projects: [
            { id: "org-project", user_id: "founder", org_id: "org-1" },
            { id: "other-org-project", user_id: "stranger", org_id: "org-2" },
            { id: "personal-project", user_id: "founder", org_id: null },
        ],
        org_members: [
            { org_id: "org-1", user_id: "founder", role: "admin" },
            { org_id: "org-1", user_id: "boss", role: "admin" },
            { org_id: "org-1", user_id: "staffer", role: "member" },
            { org_id: "org-2", user_id: "outsider", role: "admin" },
        ],
        project_access_grants: [
            // A viewer grant handed to people who already have stronger
            // standing through the org — it must not demote them.
            { project_id: "org-project", email: "boss@firm.example", role: "viewer" },
            {
                project_id: "org-project",
                email: "staffer@firm.example",
                role: "viewer",
            },
            // An outside individual: no org membership at all.
            {
                project_id: "org-project",
                email: "counsel@outside.example",
                role: "admin",
            },
        ],
        documents: [],
    });

    it("inherits project admin for an org admin", async () => {
        await expect(
            checkProjectAccess("org-project", "boss", "nobody@firm.example", db),
        ).resolves.toMatchObject({
            ok: true,
            isCreator: false,
            orgRole: "admin",
            projectRole: "admin",
        });
    });

    it("inherits project member for a plain org member", async () => {
        await expect(
            checkProjectAccess(
                "org-project",
                "staffer",
                "nobody@firm.example",
                db,
            ),
        ).resolves.toMatchObject({
            ok: true,
            orgRole: "member",
            projectRole: "member",
        });
    });

    it("never lets a weaker grant demote an inherited role (strongest wins)", async () => {
        // Org admin + viewer grant stays admin.
        await expect(
            checkProjectAccess("org-project", "boss", "boss@firm.example", db),
        ).resolves.toMatchObject({ projectRole: "admin" });
        // Org member + viewer grant stays member.
        await expect(
            checkProjectAccess(
                "org-project",
                "staffer",
                "staffer@firm.example",
                db,
            ),
        ).resolves.toMatchObject({ projectRole: "member" });
    });

    it("lets a stronger grant promote above the inherited role", async () => {
        await expect(
            checkProjectAccess(
                "org-project",
                "staffer",
                "counsel@outside.example",
                db,
            ),
        ).resolves.toMatchObject({ projectRole: "admin" });
    });

    it("admits an outsider by grant alone, with no org membership", async () => {
        const access = await checkProjectAccess(
            "org-project",
            "outside-counsel",
            "counsel@outside.example",
            db,
        );
        expect(access).toMatchObject({
            ok: true,
            orgRole: null,
            projectRole: "admin",
        });
    });

    it("isolates users across orgs (cross-tenant denial)", async () => {
        await expect(
            checkProjectAccess(
                "org-project",
                "outsider",
                "outsider@elsewhere.example",
                db,
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("keeps personal projects out of every org's reach", async () => {
        await expect(
            checkProjectAccess(
                "personal-project",
                "boss",
                "boss@firm.example",
                db,
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("upgrades a project verdict via the document's own (different) org", async () => {
        const crossDb = makeDb({
            projects: [
                { id: "p", user_id: "someone", org_id: "org-2" },
            ],
            org_members: [
                { org_id: "org-1", user_id: "u", role: "admin" },
                { org_id: "org-2", user_id: "u", role: "member" },
            ],
            project_access_grants: [],
        });
        await expect(
            ensureDocAccess(
                { user_id: "someone", project_id: "p", org_id: "org-1" },
                "u",
                "u@firm.example",
                crossDb,
            ),
        ).resolves.toMatchObject({ projectRole: "admin", orgRole: "admin" });
    });

    it("does not demote a project admin when a review is shared with them", async () => {
        await expect(
            ensureReviewAccess(
                {
                    user_id: "someone-else",
                    project_id: "org-project",
                    shared_with: ["boss@firm.example"],
                },
                "boss",
                "boss@firm.example",
                db,
            ),
        ).resolves.toMatchObject({ projectRole: "admin" });
    });
});

// ---------------------------------------------------------------------------
// Personal content carries no organization
// ---------------------------------------------------------------------------

describe("content org resolution", () => {
    const db = makeDb({
        projects: [
            { id: "org-project", user_id: "u", org_id: "org-1" },
            { id: "personal-project", user_id: "u", org_id: null },
        ],
    });

    it("inherits the project's organization for content inside it", async () => {
        await expect(
            resolveContentOrgId(db, { projectId: "org-project" }),
        ).resolves.toBe("org-1");
    });

    it("leaves content with no organization when there is none to inherit", async () => {
        // No hidden personal org to fall back on: org_id IS NULL *is* personal.
        await expect(
            resolveContentOrgId(db, { projectId: "personal-project" }),
        ).resolves.toBeNull();
        await expect(
            resolveContentOrgId(db, { projectId: null }),
        ).resolves.toBeNull();
    });
});
