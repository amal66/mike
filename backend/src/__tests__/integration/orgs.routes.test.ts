import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Organizations, invitations and project access grants, over real HTTP.
//
// lib/orgs.ts and lib/projectAccess.ts are unit-tested against their own
// fakes; what this file pins down is the part only the router owns — which
// failure kind becomes which status code, who is allowed through each
// endpoint, and the response shapes the web UI is written against.
//
// The Supabase stub here is STATEFUL, so an invitation created through POST
// really is the row a later accept/cancel finds.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

let tables: Record<string, Row[]>;
let idCounter: number;
let currentUser: { id: string; email: string };

function resetState() {
    idCounter = 1;
    currentUser = { id: "admin-1", email: "admin@firm.example" };
    tables = {
        organizations: [{ id: "org-1", name: "Acme LLP", created_by: "admin-1" }],
        org_members: [
            {
                id: "m-1",
                org_id: "org-1",
                user_id: "admin-1",
                role: "admin",
                created_at: "t1",
            },
            {
                id: "m-2",
                org_id: "org-1",
                user_id: "member-1",
                role: "member",
                created_at: "t2",
            },
        ],
        org_invitations: [],
        user_profiles: [
            {
                user_id: "admin-1",
                email: "admin@firm.example",
                display_name: "Ada",
            },
            {
                user_id: "member-1",
                email: "member@firm.example",
                display_name: "Mel",
            },
        ],
        projects: [
            {
                id: "proj-1",
                user_id: "admin-1",
                org_id: "org-1",
                shared_with: [],
            },
        ],
        project_access_grants: [],
        audit_events: [],
        documents: [],
        project_subfolders: [],
    };
}
resetState();

function query(table: string) {
    const filters: (
        | { type: "eq"; col: string; val: unknown }
        | { type: "neq"; col: string; val: unknown }
        | { type: "in"; col: string; vals: unknown[] }
    )[] = [];
    let op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
    let payload: Row | Row[] | null = null;
    let conflictCols: string[] = [];

    const ensure = () => (tables[table] ??= []);
    const matches = (rows: Row[]) =>
        rows.filter((r) =>
            filters.every((f) => {
                if (f.type === "eq") return r[f.col] === f.val;
                if (f.type === "neq") return r[f.col] !== f.val;
                return f.vals.includes(r[f.col]);
            }),
        );

    function resolveMany(): Promise<{ data: Row[]; error: null }> {
        const arr = ensure();
        if (op === "insert" || op === "upsert") {
            const rows = Array.isArray(payload) ? payload : [payload as Row];
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
                        id: `row-${idCounter++}`,
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
        limit: () => builder,
        eq: (col: string, val: unknown) => {
            filters.push({ type: "eq", col, val });
            return builder;
        },
        neq: (col: string, val: unknown) => {
            filters.push({ type: "neq", col, val });
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

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => ({
        from: (t: string) => query(t),
        rpc: vi.fn(() => Promise.resolve({ data: [], error: null })),
        auth: {
            getUser: () =>
                Promise.resolve({
                    data: { user: { id: currentUser.id } },
                    error: null,
                }),
        },
    })),
}));

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = currentUser.id;
        res.locals.userEmail = currentUser.email;
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

vi.mock("../../lib/documentVersions", () => ({
    attachActiveVersionPaths: vi.fn(async () => {}),
    attachLatestVersionNumbers: vi.fn(async () => {}),
    contentSha256: vi.fn(() => "0".repeat(64)),
    loadActiveVersion: vi.fn(async () => null),
}));

import { app } from "../../app";

const AUTH = ["Authorization", "Bearer test"] as const;
const as = (id: string, email: string) => {
    currentUser = { id, email };
};

beforeEach(() => {
    vi.clearAllMocks();
    resetState();
});

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

describe("GET /orgs", () => {
    it("returns each membership with the caller's role and roster size", async () => {
        as("member-1", "member@firm.example");
        const res = await request(app).get("/orgs").set(...AUTH);
        expect(res.status).toBe(200);
        expect(res.body).toEqual([
            expect.objectContaining({
                id: "org-1",
                name: "Acme LLP",
                role: "member",
                member_count: 2,
            }),
        ]);
    });

    it("is empty for someone in no organization — there is no personal org", async () => {
        as("loner", "loner@example.com");
        const res = await request(app).get("/orgs").set(...AUTH);
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });
});

describe("POST /orgs", () => {
    it("creates the org and makes the caller its first admin", async () => {
        as("founder", "founder@new.example");
        const res = await request(app)
            .post("/orgs")
            .set(...AUTH)
            .send({ name: "  New Firm  " });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ name: "New Firm", role: "admin" });
        expect(
            tables.org_members.filter((m) => m.user_id === "founder"),
        ).toEqual([expect.objectContaining({ role: "admin" })]);
    });

    it("400s a blank name", async () => {
        const res = await request(app)
            .post("/orgs")
            .set(...AUTH)
            .send({ name: "   " });
        expect(res.status).toBe(400);
    });
});

describe("org membership", () => {
    it("404s an org the caller does not belong to", async () => {
        as("stranger", "stranger@example.com");
        const res = await request(app).get("/orgs/org-1").set(...AUTH);
        expect(res.status).toBe(404);
    });

    it("lists members with their identity for the roster UI", async () => {
        const res = await request(app).get("/orgs/org-1/members").set(...AUTH);
        expect(res.status).toBe(200);
        expect(res.body).toEqual([
            expect.objectContaining({
                user_id: "admin-1",
                role: "admin",
                email: "admin@firm.example",
                display_name: "Ada",
            }),
            expect.objectContaining({
                user_id: "member-1",
                role: "member",
                email: "member@firm.example",
            }),
        ]);
    });

    it("409s an attempt to demote the last admin", async () => {
        const res = await request(app)
            .patch("/orgs/org-1/members/admin-1")
            .set(...AUTH)
            .send({ role: "member" });
        expect(res.status).toBe(409);
        expect(res.body.detail).toBe(
            "An organization must keep at least one admin.",
        );
    });

    it("403s a plain member trying to re-role somebody", async () => {
        as("member-1", "member@firm.example");
        const res = await request(app)
            .patch("/orgs/org-1/members/admin-1")
            .set(...AUTH)
            .send({ role: "member" });
        expect(res.status).toBe(403);
        expect(res.body.detail).toBe("Only an organization admin can do that.");
    });

    it("lets a member leave on their own (204)", async () => {
        as("member-1", "member@firm.example");
        const res = await request(app)
            .delete("/orgs/org-1/members/member-1")
            .set(...AUTH);
        expect(res.status).toBe(204);
        expect(tables.org_members.map((m) => m.user_id)).toEqual(["admin-1"]);
    });

    it("has no endpoint that adds a member directly", async () => {
        // Membership only ever arrives through an accepted invitation.
        const res = await request(app)
            .post("/orgs/org-1/members")
            .set(...AUTH)
            .send({ email: "someone@example.com", role: "member" });
        expect(res.status).toBe(404);
    });
});

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

async function invite(email: string, role = "member") {
    return request(app)
        .post("/orgs/org-1/invitations")
        .set(...AUTH)
        .send({ email, role });
}

describe("organization invitations", () => {
    it("an admin invites an email, and no membership appears", async () => {
        const res = await invite("New@Hire.example", "admin");
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
            email: "new@hire.example",
            role: "admin",
            status: "pending",
        });
        expect(tables.org_members).toHaveLength(2);
    });

    it("403s a plain member trying to invite", async () => {
        as("member-1", "member@firm.example");
        const res = await invite("new@hire.example");
        expect(res.status).toBe(403);
    });

    it("409s a duplicate live invitation", async () => {
        await invite("new@hire.example");
        const res = await invite("new@hire.example");
        expect(res.status).toBe(409);
    });

    it("400s a malformed address", async () => {
        const res = await invite("not-an-email");
        expect(res.status).toBe(400);
    });

    // 'owner' is a tier this product removed. Answering a request for it with
    // a quiet 'member' invitation and a 201 would tell the caller their
    // choice was honoured when it was replaced, so the retired names get the
    // same 400 that updateMember and project sharing already give.
    it("400s a retired role name rather than quietly downgrading it", async () => {
        for (const role of ["owner", "manager", "editor"]) {
            const res = await request(app)
                .post("/orgs/org-1/invitations")
                .set(...AUTH)
                .send({ email: "new@hire.example", role });
            expect(res.status).toBe(400);
        }
        expect(tables.org_invitations ?? []).toHaveLength(0);
    });

    it("still defaults an omitted role to member", async () => {
        const res = await request(app)
            .post("/orgs/org-1/invitations")
            .set(...AUTH)
            .send({ email: "new@hire.example" });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ role: "member" });
    });

    it("shows an admin the invitation roster, and hides it from members", async () => {
        await invite("new@hire.example");
        const admin = await request(app)
            .get("/orgs/org-1/invitations")
            .set(...AUTH);
        expect(admin.status).toBe(200);
        expect(admin.body).toEqual([
            expect.objectContaining({
                email: "new@hire.example",
                status: "pending",
                invited_by_email: "admin@firm.example",
            }),
        ]);

        as("member-1", "member@firm.example");
        const member = await request(app)
            .get("/orgs/org-1/invitations")
            .set(...AUTH);
        expect(member.status).toBe(403);
    });

    it("surfaces the invitation to its recipient and joins them on accept", async () => {
        const created = await invite("new@hire.example", "admin");
        const invitationId = created.body.id as string;

        as("new-hire", "New@Hire.example");
        const mine = await request(app).get("/user/invitations").set(...AUTH);
        expect(mine.status).toBe(200);
        expect(mine.body).toEqual([
            expect.objectContaining({
                id: invitationId,
                org_id: "org-1",
                org_name: "Acme LLP",
                role: "admin",
            }),
        ]);

        const accepted = await request(app)
            .post(`/user/invitations/${invitationId}/accept`)
            .set(...AUTH);
        expect(accepted.status).toBe(200);
        expect(accepted.body).toEqual({ org_id: "org-1", role: "admin" });
        expect(
            tables.org_members.find((m) => m.user_id === "new-hire"),
        ).toMatchObject({ role: "admin" });
    });

    it("204s a decline and creates no membership", async () => {
        const created = await invite("new@hire.example");
        as("new-hire", "new@hire.example");
        const res = await request(app)
            .post(`/user/invitations/${created.body.id}/decline`)
            .set(...AUTH);
        expect(res.status).toBe(204);
        expect(tables.org_members).toHaveLength(2);
        expect(tables.org_invitations[0].status).toBe("declined");
    });

    it("404s somebody else's invitation rather than confirming it exists", async () => {
        const created = await invite("new@hire.example");
        as("intruder", "intruder@elsewhere.example");
        const res = await request(app)
            .post(`/user/invitations/${created.body.id}/accept`)
            .set(...AUTH);
        expect(res.status).toBe(404);
        expect(tables.org_members).toHaveLength(2);
    });

    it("410s an expired invitation, which is not the same as a missing one", async () => {
        const created = await invite("new@hire.example");
        tables.org_invitations[0].expires_at = new Date(
            Date.now() - 1000,
        ).toISOString();

        as("new-hire", "new@hire.example");
        const res = await request(app)
            .post(`/user/invitations/${created.body.id}/accept`)
            .set(...AUTH);
        expect(res.status).toBe(410);
        expect(res.body.detail).toBe("That invitation has expired.");
        // ...and it is not offered in the recipient's list either.
        const mine = await request(app).get("/user/invitations").set(...AUTH);
        expect(mine.body).toEqual([]);
    });

    it("an admin cancels an invitation, and acceptance then 409s", async () => {
        const created = await invite("new@hire.example");
        const cancelled = await request(app)
            .delete(`/orgs/org-1/invitations/${created.body.id}`)
            .set(...AUTH);
        expect(cancelled.status).toBe(204);

        as("new-hire", "new@hire.example");
        const res = await request(app)
            .post(`/user/invitations/${created.body.id}/accept`)
            .set(...AUTH);
        expect(res.status).toBe(409);
    });

    it("resend pushes the expiry back out", async () => {
        const created = await invite("new@hire.example");
        tables.org_invitations[0].expires_at = new Date(
            Date.now() - 1000,
        ).toISOString();
        const res = await request(app)
            .post(`/orgs/org-1/invitations/${created.body.id}/resend`)
            .set(...AUTH);
        expect(res.status).toBe(200);
        expect(new Date(res.body.expires_at).getTime()).toBeGreaterThan(
            Date.now(),
        );
    });

    it("claim-after-signup: an invitation predating the account still lands", async () => {
        await invite("future@hire.example", "member");
        // A brand-new account whose profile did not exist at invite time.
        as("brand-new", "future@hire.example");
        const mine = await request(app).get("/user/invitations").set(...AUTH);
        expect(mine.body).toHaveLength(1);
        const res = await request(app)
            .post(`/user/invitations/${mine.body[0].id}/accept`)
            .set(...AUTH);
        expect(res.status).toBe(200);
        expect(
            tables.org_members.find((m) => m.user_id === "brand-new"),
        ).toMatchObject({ org_id: "org-1", role: "member" });
    });
});

// ---------------------------------------------------------------------------
// Project access grants
// ---------------------------------------------------------------------------

describe("project access grants over HTTP", () => {
    it("an admin shares an org project with an outsider at a chosen role", async () => {
        const res = await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "counsel@outside.example", role: "viewer" });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
            email: "counsel@outside.example",
            role: "viewer",
        });
        // No organization membership was created for them.
        expect(tables.org_members).toHaveLength(2);
        // The legacy mirror column keeps up.
        expect(tables.projects[0].shared_with).toEqual([
            "counsel@outside.example",
        ]);
    });

    it("400s an invalid role and self-sharing", async () => {
        const badRole = await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "x@y.example", role: "manager" });
        expect(badRole.status).toBe(400);

        const self = await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "Admin@Firm.example", role: "member" });
        expect(self.status).toBe(400);
    });

    it("403s a member trying to change who has access", async () => {
        as("member-1", "member@firm.example");
        const res = await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "counsel@outside.example", role: "viewer" });
        expect(res.status).toBe(403);
        expect(res.body.detail).toBe(
            "Only a project admin can change who has access.",
        );
    });

    it("lists grants for anyone who can see the project", async () => {
        await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "counsel@outside.example", role: "viewer" });

        as("member-1", "member@firm.example");
        const res = await request(app)
            .get("/projects/proj-1/access")
            .set(...AUTH);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            org_id: "org-1",
            access_role: "member",
        });
        expect(res.body.grants).toEqual([
            expect.objectContaining({
                email: "counsel@outside.example",
                role: "viewer",
            }),
        ]);
    });

    it("revokes a grant, and 404s one that was never there", async () => {
        await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "counsel@outside.example", role: "viewer" });

        const gone = await request(app)
            .delete("/projects/proj-1/access/counsel%40outside.example")
            .set(...AUTH);
        expect(gone.status).toBe(204);
        expect(tables.project_access_grants).toHaveLength(0);
        expect(tables.projects[0].shared_with).toEqual([]);

        const missing = await request(app)
            .delete("/projects/proj-1/access/ghost%40outside.example")
            .set(...AUTH);
        expect(missing.status).toBe(404);
    });

    it("an outside grantee reaches the project with no org membership", async () => {
        await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "counsel@outside.example", role: "admin" });

        as("outsider", "counsel@outside.example");
        const res = await request(app).get("/projects/proj-1").set(...AUTH);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            access_role: "admin",
            is_owner: false,
            org_role: null,
        });
    });
});

// ---------------------------------------------------------------------------
// The contact fields the permission popups need
// ---------------------------------------------------------------------------

describe("GET /projects/:projectId admin contacts", () => {
    it("names the creator and the org's admins so a refusal can say who to ask", async () => {
        as("member-1", "member@firm.example");
        const res = await request(app).get("/projects/proj-1").set(...AUTH);
        expect(res.status).toBe(200);
        // owner_email was declared on this shape for a long time and always
        // came back null, so the UI's "ask …" line could never render.
        expect(res.body.owner_email).toBe("admin@firm.example");
        expect(res.body.owner_display_name).toBe("Ada");
        expect(res.body.admin_contacts).toEqual([
            expect.objectContaining({
                email: "admin@firm.example",
                source: "creator",
            }),
        ]);
        expect(res.body.access_role).toBe("member");
    });
});
