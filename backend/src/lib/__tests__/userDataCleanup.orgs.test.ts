import { describe, expect, it } from "vitest";

import {
    deleteUserOrganizations,
    deleteUserProjects,
} from "../userDataCleanup";

type Row = Record<string, unknown>;

// Stateful fake with a minimal simulation of the ON DELETE CASCADE from
// org_members → organizations, so deleting an org also drops its membership
// rows (as Postgres would). Supports the query subset the cleanup uses:
// select/eq/neq/in/order/limit/delete/update + thenable.
//
// `options.selectErrors` makes one table's reads fail, so a caller that
// ignores a read error can be caught doing it.
function makeDb(
    initial: Record<string, Row[]>,
    options: { selectErrors?: Record<string, string> } = {},
) {
    const tables: Record<string, Row[]> = {};
    for (const [k, v] of Object.entries(initial)) tables[k] = v.map((r) => ({ ...r }));

    function query(table: string) {
        const filters: (
            | { type: "eq"; col: string; val: unknown }
            | { type: "neq"; col: string; val: unknown }
            | { type: "in"; col: string; vals: unknown[] }
        )[] = [];
        let op: "select" | "update" | "delete" = "select";
        let payload: Row | null = null;
        let orderCol: string | null = null;
        let orderAsc = true;
        let limitN: number | null = null;

        const ensure = () => (tables[table] ??= []);
        const matches = (rows: Row[]) =>
            rows.filter((r) =>
                filters.every((f) => {
                    if (f.type === "eq") return r[f.col] === f.val;
                    if (f.type === "neq") return r[f.col] !== f.val;
                    return f.vals.includes(r[f.col]);
                }),
            );

        function resolveMany(): Promise<{
            data: Row[] | null;
            error: { message: string; code?: string } | null;
        }> {
            const arr = ensure();
            const matched = matches(arr);
            if (op === "select" && options.selectErrors?.[table]) {
                return Promise.resolve({
                    data: null,
                    error: { message: options.selectErrors[table] },
                });
            }
            if (op === "update") {
                for (const r of matched) Object.assign(r, payload as Row);
                return Promise.resolve({ data: matched, error: null });
            }
            if (op === "delete") {
                tables[table] = arr.filter((r) => !matched.includes(r));
                if (table === "organizations") {
                    // Simulate the FK cascade to org_members.
                    const goneOrgIds = new Set(matched.map((r) => r.id));
                    tables.org_members = (tables.org_members ?? []).filter(
                        (m) => !goneOrgIds.has(m.org_id),
                    );
                }
                return Promise.resolve({ data: matched, error: null });
            }
            let out = [...matched];
            if (orderCol) {
                const col = orderCol;
                out.sort((a, b) =>
                    ((a[col] as number) > (b[col] as number) ? 1 : -1) *
                    (orderAsc ? 1 : -1),
                );
            }
            if (limitN != null) out = out.slice(0, limitN);
            return Promise.resolve({ data: out, error: null });
        }

        const builder: Record<string, unknown> = {
            select: () => builder,
            eq: (col: string, val: unknown) => {
                filters.push({ type: "eq", col, val });
                return builder;
            },
            neq: (col: string, val: unknown) => {
                filters.push({ type: "neq", col, val });
                return builder;
            },
            order: (col: string, opts?: { ascending?: boolean }) => {
                orderCol = col;
                orderAsc = opts?.ascending !== false;
                return builder;
            },
            limit: (n: number) => {
                limitN = n;
                return builder;
            },
            update: (p: Row) => {
                op = "update";
                payload = p;
                return builder;
            },
            delete: () => {
                op = "delete";
                return builder;
            },
            in: (col: string, vals: unknown[]) => {
                filters.push({ type: "in", col, vals });
                return builder;
            },
            then: (
                resolve: (v: {
                    data: Row[] | null;
                    error: { message: string; code?: string } | null;
                }) => unknown,
                reject?: (e: unknown) => unknown,
            ) => resolveMany().then(resolve, reject),
        };
        return builder;
    }

    return { from: (t: string) => query(t), _tables: tables } as any;
}

describe("deleteUserOrganizations", () => {
    it("hands administration to the earliest remaining member", async () => {
        const db = makeDb({
            organizations: [{ id: "shared1", name: "Acme" }],
            org_members: [
                {
                    id: "m1",
                    org_id: "shared1",
                    user_id: "u1",
                    role: "admin",
                    created_at: 1,
                },
                {
                    id: "m2",
                    org_id: "shared1",
                    user_id: "u2",
                    role: "member",
                    created_at: 2,
                },
                {
                    id: "m3",
                    org_id: "shared1",
                    user_id: "u3",
                    role: "member",
                    created_at: 3,
                },
            ],
        });

        await deleteUserOrganizations(db, "u1");

        // The org survives its only admin's departure, with a successor.
        expect(db._tables.organizations).toHaveLength(1);
        const members = db._tables.org_members as Row[];
        expect(members.map((m) => m.user_id)).toEqual(["u2", "u3"]);
        expect(members.find((m) => m.user_id === "u2")?.role).toBe("admin");
    });

    it("leaves a co-admin's org untouched", async () => {
        const db = makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "u1", role: "admin", created_at: 1 },
                { id: "m2", org_id: "o1", user_id: "u2", role: "admin", created_at: 2 },
            ],
        });
        await deleteUserOrganizations(db, "u1");
        const members = db._tables.org_members as Row[];
        expect(members).toHaveLength(1);
        expect(members[0]).toMatchObject({ user_id: "u2", role: "admin" });
    });

    it("deletes an org only when nobody and nothing is left in it", async () => {
        const db = makeDb({
            organizations: [{ id: "empty", name: "Empty" }],
            org_members: [
                { id: "m1", org_id: "empty", user_id: "u1", role: "admin", created_at: 1 },
            ],
            projects: [],
        });
        await deleteUserOrganizations(db, "u1");
        expect(db._tables.organizations).toHaveLength(0);
    });

    it("keeps a memberless org that still holds the firm's projects", async () => {
        // Deleting it would SET NULL the org_id on those projects and strand
        // the content this whole model exists to protect.
        const db = makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            org_members: [
                { id: "m1", org_id: "o1", user_id: "u1", role: "admin", created_at: 1 },
            ],
            projects: [{ id: "p1", org_id: "o1", user_id: "u1" }],
        });
        await deleteUserOrganizations(db, "u1");
        expect(db._tables.organizations).toHaveLength(1);
        expect(db._tables.org_members).toHaveLength(0);
        expect(db._tables.projects).toHaveLength(1);
    });

    it("refuses to delete an org because a lookup failed", async () => {
        // The three org-shaping reads destructured `data` only, so a transient
        // error read as "no projects here" — and the difference between "this
        // org holds nothing" and "the database did not answer" is the
        // difference between tidying up and deleting a firm's tenant.
        const db = makeDb(
            {
                organizations: [{ id: "o1", name: "Acme" }],
                org_members: [
                    { id: "m1", org_id: "o1", user_id: "u1", role: "admin", created_at: 1 },
                ],
                projects: [{ id: "p1", org_id: "o1", user_id: "u1" }],
            },
            { selectErrors: { projects: "connection reset" } },
        );

        await expect(deleteUserOrganizations(db, "u1")).rejects.toThrow(
            /Failed to load org projects/,
        );
        expect(db._tables.organizations).toHaveLength(1);
    });

    it("cancels invitations still addressed to the departing account", async () => {
        const db = makeDb({
            organizations: [{ id: "o1", name: "Acme" }],
            org_members: [],
            org_invitations: [
                {
                    id: "i1",
                    org_id: "o1",
                    email: "gone@example.com",
                    status: "pending",
                },
                {
                    id: "i2",
                    org_id: "o1",
                    email: "other@example.com",
                    status: "pending",
                },
            ],
        });
        await deleteUserOrganizations(db, "u1", " Gone@Example.com ");
        const invites = db._tables.org_invitations as Row[];
        expect(invites.find((i) => i.id === "i1")?.status).toBe("cancelled");
        expect(invites.find((i) => i.id === "i2")?.status).toBe("pending");
    });
});

describe("deleteUserProjects and organization ownership", () => {
    const seed = () =>
        makeDb({
            projects: [
                { id: "personal", user_id: "u1", org_id: null },
                { id: "firm", user_id: "u1", org_id: "o1" },
            ],
            documents: [
                { id: "d-personal", project_id: "personal" },
                { id: "d-firm", project_id: "firm" },
            ],
            chats: [],
            tabular_reviews: [],
            project_subfolders: [],
            document_versions: [],
        });

    it("destroys personal projects but detaches organization ones", async () => {
        const db = seed();
        // The count reports what was actually destroyed, so a caller deleting
        // only an org project is told nothing was removed.
        await expect(deleteUserProjects(db, "u1")).resolves.toBe(1);

        const projects = db._tables.projects as Row[];
        expect(projects.map((p) => p.id)).toEqual(["firm"]);
        // The organization's project survives its creator, with no creator.
        expect(projects[0].user_id).toBeNull();
        expect(projects[0].org_id).toBe("o1");
        // …and so does the content inside it.
        expect((db._tables.documents as Row[]).map((d) => d.id)).toEqual([
            "d-firm",
        ]);
    });

    it("detaches an organization project even when named explicitly", async () => {
        const db = seed();
        await expect(deleteUserProjects(db, "u1", ["firm"])).resolves.toBe(0);
        const projects = db._tables.projects as Row[];
        expect(projects).toHaveLength(2);
        expect(projects.find((p) => p.id === "firm")?.user_id).toBeNull();
    });
});
