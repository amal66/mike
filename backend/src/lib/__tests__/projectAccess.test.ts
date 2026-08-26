import { describe, expect, it } from "vitest";
import {
    deleteProjectGrant,
    listProjectAdminContacts,
    listProjectGrants,
    removeGrantsForEmail,
    replaceGrantsFromEmails,
    upsertProjectGrant,
} from "../projectAccess";

type Row = Record<string, unknown>;

// Stateful fake supporting the subset projectAccess.ts uses, including
// `upsert(..., { onConflict })` — the grant table's whole point is that
// re-sharing with a different role is an update, not a conflict.
function makeDb(initial: Record<string, Row[]>) {
    const tables: Record<string, Row[]> = {};
    for (const [k, v] of Object.entries(initial)) {
        tables[k] = v.map((r) => ({ ...r }));
    }
    let idCounter = 1;

    function query(table: string) {
        const filters: (
            | { type: "eq"; col: string; val: unknown }
            | { type: "in"; col: string; vals: unknown[] }
        )[] = [];
        let op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
        let payload: Row | Row[] | null = null;
        let conflictCols: string[] = [];

        const ensure = () => (tables[table] ??= []);
        const matches = (rows: Row[]) =>
            rows.filter((r) =>
                filters.every((f) =>
                    f.type === "eq"
                        ? r[f.col] === f.val
                        : f.vals.includes(r[f.col]),
                ),
            );

        function resolveMany(): Promise<{ data: Row[]; error: null }> {
            const arr = ensure();
            if (op === "insert" || op === "upsert") {
                const rows = Array.isArray(payload)
                    ? payload
                    : [payload as Row];
                const out: Row[] = [];
                for (const r of rows) {
                    const existing =
                        op === "upsert" && conflictCols.length > 0
                            ? arr.find((e) =>
                                  conflictCols.every((c) => e[c] === r[c]),
                              )
                            : undefined;
                    if (existing) {
                        Object.assign(existing, r);
                        out.push(existing);
                    } else {
                        const created = {
                            id: `grant-${idCounter++}`,
                            created_at: `t${idCounter}`,
                            ...r,
                        };
                        arr.push(created);
                        out.push(created);
                    }
                }
                return Promise.resolve({ data: out, error: null });
            }
            const matched = matches(arr);
            if (op === "update") {
                for (const r of matched) Object.assign(r, payload as Row);
                return Promise.resolve({ data: matched, error: null });
            }
            if (op === "delete") {
                tables[table] = arr.filter((r) => !matched.includes(r));
                return Promise.resolve({ data: matched, error: null });
            }
            return Promise.resolve({ data: matched, error: null });
        }

        const builder: Record<string, unknown> = {
            select: () => builder,
            order: () => builder,
            eq: (col: string, val: unknown) => {
                filters.push({ type: "eq", col, val });
                return builder;
            },
            in: (col: string, vals: unknown[]) => {
                filters.push({ type: "in", col, vals });
                return builder;
            },
            insert: (p: Row | Row[]) => {
                op = "insert";
                payload = p;
                return builder;
            },
            upsert: (p: Row | Row[], opts?: { onConflict?: string }) => {
                op = "upsert";
                payload = p;
                conflictCols = (opts?.onConflict ?? "")
                    .split(",")
                    .map((c) => c.trim())
                    .filter(Boolean);
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
            single: async () => {
                const { data } = await resolveMany();
                return { data: data[0] ?? null, error: null };
            },
            maybeSingle: async () => {
                const { data } = await resolveMany();
                return { data: data[0] ?? null, error: null };
            },
            then: (
                resolve: (v: { data: Row[]; error: null }) => unknown,
                reject?: (e: unknown) => unknown,
            ) => resolveMany().then(resolve, reject),
        };
        return builder;
    }

    return { from: (t: string) => query(t), _tables: tables } as any;
}

const seed = () =>
    makeDb({
        projects: [
            { id: "p1", user_id: "creator", org_id: null, shared_with: [] },
        ],
        project_access_grants: [],
        user_profiles: [
            { user_id: "creator", email: "creator@firm.example", display_name: "Cee" },
        ],
        org_members: [],
    });

describe("project access grants", () => {
    it("creates a grant with the requested role and normalizes the email", async () => {
        const db = seed();
        const result = await upsertProjectGrant(db, {
            projectId: "p1",
            email: "  Outside@Counsel.Example ",
            role: "viewer",
            createdBy: "creator",
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.grant).toMatchObject({
            email: "outside@counsel.example",
            role: "viewer",
        });
    });

    it("re-sharing changes the role instead of conflicting", async () => {
        const db = seed();
        await upsertProjectGrant(db, {
            projectId: "p1",
            email: "counsel@outside.example",
            role: "viewer",
            createdBy: "creator",
        });
        const promoted = await upsertProjectGrant(db, {
            projectId: "p1",
            email: "counsel@outside.example",
            role: "admin",
            createdBy: "creator",
        });
        expect(promoted.ok).toBe(true);
        const grants = await listProjectGrants(db, "p1");
        expect(grants).toHaveLength(1);
        expect(grants[0].role).toBe("admin");
    });

    it("rejects a malformed address, an unknown role, and the creator", async () => {
        const db = seed();
        await expect(
            upsertProjectGrant(db, {
                projectId: "p1",
                email: "nope",
                role: "viewer",
                createdBy: "creator",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "validation" });
        await expect(
            upsertProjectGrant(db, {
                projectId: "p1",
                email: "x@y.example",
                role: "manager",
                createdBy: "creator",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "validation" });
        await expect(
            upsertProjectGrant(db, {
                projectId: "p1",
                email: "Creator@Firm.example",
                role: "viewer",
                createdBy: "creator",
                creatorEmail: "creator@firm.example",
            }),
        ).resolves.toMatchObject({ ok: false, kind: "validation" });
    });

    it("keeps projects.shared_with as a mirror of the grant emails", async () => {
        const db = seed();
        await upsertProjectGrant(db, {
            projectId: "p1",
            email: "a@x.example",
            role: "member",
            createdBy: "creator",
        });
        await upsertProjectGrant(db, {
            projectId: "p1",
            email: "b@x.example",
            role: "viewer",
            createdBy: "creator",
        });
        expect((db._tables.projects as Row[])[0].shared_with).toEqual([
            "a@x.example",
            "b@x.example",
        ]);

        await deleteProjectGrant(db, { projectId: "p1", email: "A@X.example" });
        expect((db._tables.projects as Row[])[0].shared_with).toEqual([
            "b@x.example",
        ]);
    });

    it("reports whether a revoke actually removed anything", async () => {
        const db = seed();
        await expect(
            deleteProjectGrant(db, { projectId: "p1", email: "ghost@x.example" }),
        ).resolves.toMatchObject({ ok: true, removed: false });
    });

    it("treats a roleless shared_with array as the set of grantees", async () => {
        const db = seed();
        await upsertProjectGrant(db, {
            projectId: "p1",
            email: "keeper@x.example",
            role: "admin",
            createdBy: "creator",
        });
        await replaceGrantsFromEmails(db, {
            projectId: "p1",
            emails: ["keeper@x.example", " NEW@x.example "],
            createdBy: "creator",
        });
        const grants = await listProjectGrants(db, "p1");
        expect(
            Object.fromEntries(grants.map((g) => [g.email, g.role])),
        ).toEqual({
            // A client that cannot express roles must not silently demote an
            // admin collaborator it merely re-sent.
            "keeper@x.example": "admin",
            "new@x.example": "member",
        });
    });

    it("drops grantees the roleless array no longer names", async () => {
        const db = seed();
        await replaceGrantsFromEmails(db, {
            projectId: "p1",
            emails: ["a@x.example", "b@x.example"],
            createdBy: "creator",
        });
        await replaceGrantsFromEmails(db, {
            projectId: "p1",
            emails: ["b@x.example"],
            createdBy: "creator",
        });
        expect((await listProjectGrants(db, "p1")).map((g) => g.email)).toEqual([
            "b@x.example",
        ]);
    });

    it("revokes every grant addressed to a departing account", async () => {
        const db = seed();
        await replaceGrantsFromEmails(db, {
            projectId: "p1",
            emails: ["gone@x.example", "stays@x.example"],
            createdBy: "creator",
        });
        await removeGrantsForEmail(db, " Gone@X.example ");
        expect((await listProjectGrants(db, "p1")).map((g) => g.email)).toEqual([
            "stays@x.example",
        ]);
        expect((db._tables.projects as Row[])[0].shared_with).toEqual([
            "stays@x.example",
        ]);
    });
});

describe("project admin contacts", () => {
    it("names the creator, direct admins and org admins, in that order", async () => {
        const db = makeDb({
            projects: [
                { id: "p1", user_id: "creator", org_id: "o1", shared_with: [] },
            ],
            project_access_grants: [
                {
                    id: "g1",
                    project_id: "p1",
                    email: "counsel@outside.example",
                    role: "admin",
                    created_at: "t1",
                },
                {
                    id: "g2",
                    project_id: "p1",
                    email: "reader@outside.example",
                    role: "viewer",
                    created_at: "t2",
                },
            ],
            org_members: [
                { org_id: "o1", user_id: "boss", role: "admin" },
                { org_id: "o1", user_id: "staffer", role: "member" },
            ],
            user_profiles: [
                {
                    user_id: "creator",
                    email: "creator@firm.example",
                    display_name: "Cee",
                },
                { user_id: "boss", email: "boss@firm.example", display_name: "Bee" },
            ],
        });

        const contacts = await listProjectAdminContacts(db, {
            id: "p1",
            user_id: "creator",
            org_id: "o1",
        });
        expect(contacts).toEqual([
            {
                user_id: "creator",
                email: "creator@firm.example",
                display_name: "Cee",
                source: "creator",
            },
            {
                user_id: null,
                email: "counsel@outside.example",
                display_name: null,
                source: "grant",
            },
            {
                user_id: "boss",
                email: "boss@firm.example",
                display_name: "Bee",
                source: "organization",
            },
        ]);
        // Viewers and plain org members are not someone to ask for access.
        expect(contacts.map((c) => c.email)).not.toContain(
            "reader@outside.example",
        );
    });

    it("still names the org's admins when the creator's account is gone", async () => {
        // This is the case an org project is designed to survive: user_id is
        // NULL, and the firm's admins are who you ask.
        const db = makeDb({
            projects: [{ id: "p1", user_id: null, org_id: "o1", shared_with: [] }],
            project_access_grants: [],
            org_members: [{ org_id: "o1", user_id: "boss", role: "admin" }],
            user_profiles: [
                { user_id: "boss", email: "boss@firm.example", display_name: "Bee" },
            ],
        });
        const contacts = await listProjectAdminContacts(db, {
            id: "p1",
            user_id: null,
            org_id: "o1",
        });
        expect(contacts).toEqual([
            {
                user_id: "boss",
                email: "boss@firm.example",
                display_name: "Bee",
                source: "organization",
            },
        ]);
    });
});
