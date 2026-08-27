import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Gated: runs only against a real (local) Supabase stack.
//   supabase start, then export:
//     SUPABASE_TEST_URL, SUPABASE_TEST_SERVICE_ROLE_KEY
// or use scripts/test-stack.sh which reads them from `supabase status`.
//
// What this pins: 20260828_05 changed get_chats_overview's signature, and
// migrations land BEFORE the code that needs them. During the rollout, API
// instances still running pre-#363 code keep calling the OLD three-argument
// shape, so the migration keeps that signature alive as a wrapper that
// delegates to the new function with p_user_email => null.
//
// Two things have to hold for that wrapper to be worth having, and only a
// real stack can show either — the whole mechanism is PostgREST's overload
// resolution plus Postgres's:
//
//   1. BOTH signatures resolve. An overload pair is only usable if every
//      call site picks exactly one candidate; had the new function kept
//      `p_user_email text default null`, the old three-key call would match
//      both and fail with PGRST203 / Postgres 42725. This test is what
//      catches a future edit that re-adds that default.
//   2. The wrapper's rows are the PRE-migration rows, not the new ones. Old
//      code renders whatever comes back; if the wrapper leaked the new
//      shared_with arms, the deploy window would show users chats their
//      running code never intended to list.
const url = process.env.SUPABASE_TEST_URL;
const serviceKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
const maybeDescribe = url && serviceKey ? describe : describe.skip;

maybeDescribe("get_chats_overview — deploy-window overload pair", () => {
    let admin: SupabaseClient;
    let callerId = "";
    let callerEmail = "";
    let strangerId = "";

    // One org the caller belongs to, one they do not.
    const sharedOrgId = crypto.randomUUID();
    const foreignOrgId = crypto.randomUUID();

    const myProjectId = crypto.randomUUID();
    const sharedOrgProjectId = crypto.randomUUID();
    const grantedProjectId = crypto.randomUUID();
    const foreignOrgProjectId = crypto.randomUUID();

    // Named by the access branch each one exercises. The first three are
    // visible under BOTH the old and new predicates; the last three are the
    // ones #363 adds (or still denies).
    const chats = {
        mine: crypto.randomUUID(), // branch 1: chat owner
        inMyProject: crypto.randomUUID(), // branch 4: project owner
        inSharedOrgProject: crypto.randomUUID(), // branch 4: project-org member
        inGrantedProject: crypto.randomUUID(), // branch 4: project access grant — NEW
        sharedDirectly: crypto.randomUUID(), // branch 2: chat shared_with — NEW
        strangers: crypto.randomUUID(), // no branch: never visible
    };
    const allChatIds = Object.values(chats);

    const titlesFrom = (rows: unknown) =>
        (rows as { id: string; title: string }[])
            .filter((r) => allChatIds.includes(r.id))
            .map((r) => r.title)
            .sort();

    beforeAll(async () => {
        admin = createClient(url!, serviceKey!, {
            auth: { persistSession: false, autoRefreshToken: false },
        });

        const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        callerEmail = `chats-caller-${suffix}@test.local`;
        const caller = await admin.auth.admin.createUser({
            email: callerEmail,
            password: "StackTest1!",
            email_confirm: true,
        });
        if (caller.error || !caller.data.user) {
            throw caller.error ?? new Error("Could not create caller");
        }
        callerId = caller.data.user.id;

        const stranger = await admin.auth.admin.createUser({
            email: `chats-stranger-${suffix}@test.local`,
            password: "StackTest1!",
            email_confirm: true,
        });
        if (stranger.error || !stranger.data.user) {
            throw stranger.error ?? new Error("Could not create stranger");
        }
        strangerId = stranger.data.user.id;

        const orgs = await admin.from("organizations").insert([
            { id: sharedOrgId, name: `shared-${suffix}`, created_by: strangerId },
            { id: foreignOrgId, name: `foreign-${suffix}`, created_by: strangerId },
        ]);
        if (orgs.error) throw orgs.error;

        const members = await admin.from("org_members").insert([
            { org_id: sharedOrgId, user_id: callerId, role: "member" },
            { org_id: sharedOrgId, user_id: strangerId, role: "admin" },
            { org_id: foreignOrgId, user_id: strangerId, role: "admin" },
        ]);
        if (members.error) throw members.error;

        const projects = await admin.from("projects").insert([
            { id: myProjectId, user_id: callerId, name: `mine-${suffix}`, shared_with: [] },
            {
                id: sharedOrgProjectId,
                user_id: strangerId,
                name: `org-${suffix}`,
                org_id: sharedOrgId,
                shared_with: [],
            },
            {
                id: grantedProjectId,
                user_id: strangerId,
                name: `granted-${suffix}`,
                shared_with: [],
            },
            {
                id: foreignOrgProjectId,
                user_id: strangerId,
                name: `foreign-${suffix}`,
                org_id: foreignOrgId,
                shared_with: [],
            },
        ]);
        if (projects.error) throw projects.error;

        // Direct project sharing is a role-carrying grant row since
        // 20260828_01; projects.shared_with is no longer the access source,
        // so seeding it would prove nothing.
        const grants = await admin.from("project_access_grants").insert([
            {
                project_id: grantedProjectId,
                email: callerEmail.toLowerCase(),
                role: "member",
                created_by: strangerId,
            },
        ]);
        if (grants.error) throw grants.error;

        // Chats with no project carry org_id null — there is no personal
        // organization to park them in. Stamping the fixtures the way
        // resolveContentOrgId stamps real rows is what makes the "the chat's
        // own org branch can never add a row" claim in 20260828_05's header
        // testable rather than merely asserted.
        const chatRows = await admin.from("chats").insert([
            {
                id: chats.mine,
                project_id: null,
                user_id: callerId,
                title: "mine",
                shared_with: [],
                org_id: null,
            },
            {
                id: chats.inMyProject,
                project_id: myProjectId,
                user_id: strangerId,
                title: "inMyProject",
                shared_with: [],
                org_id: null,
            },
            {
                id: chats.inSharedOrgProject,
                project_id: sharedOrgProjectId,
                user_id: strangerId,
                title: "inSharedOrgProject",
                shared_with: [],
                org_id: sharedOrgId,
            },
            {
                id: chats.inGrantedProject,
                project_id: grantedProjectId,
                user_id: strangerId,
                title: "inGrantedProject",
                shared_with: [],
                org_id: null,
            },
            {
                id: chats.sharedDirectly,
                project_id: null,
                user_id: strangerId,
                title: "sharedDirectly",
                shared_with: [callerEmail.toLowerCase()],
                org_id: null,
            },
            {
                id: chats.strangers,
                project_id: foreignOrgProjectId,
                user_id: strangerId,
                title: "strangers",
                shared_with: [],
                org_id: foreignOrgId,
            },
        ]);
        if (chatRows.error) throw chatRows.error;
    });

    afterAll(async () => {
        if (!admin) return;
        await admin.from("chats").delete().in("id", allChatIds);
        await admin
            .from("projects")
            .delete()
            .in("id", [
                myProjectId,
                sharedOrgProjectId,
                grantedProjectId,
                foreignOrgProjectId,
            ]);
        await admin.from("organizations").delete().in("id", [sharedOrgId, foreignOrgId]);
        if (callerId) await admin.auth.admin.deleteUser(callerId);
        if (strangerId) await admin.auth.admin.deleteUser(strangerId);
    });

    it("still answers the pre-#363 three-argument call", async () => {
        // A pre-#363 API instance sends exactly these three keys. If the
        // overload pair were ambiguous this comes back PGRST203; if the old
        // signature had simply been dropped, PGRST202.
        const legacy = await admin.rpc("get_chats_overview", {
            p_user_id: callerId,
            p_limit: null,
            p_offset: 0,
        });

        expect(legacy.error).toBeNull();
        expect(titlesFrom(legacy.data)).toEqual(
            ["inMyProject", "inSharedOrgProject", "mine"].sort(),
        );
        // Old callers must keep seeing the pre-#363 column set — which since
        // #383 includes `model` (main's 20260826_01 added it to this
        // signature before this branch existed).
        const row = (legacy.data as Record<string, unknown>[]).find(
            (r) => r.id === chats.mine,
        );
        expect(row).toBeDefined();
        expect(Object.keys(row!).sort()).toEqual([
            "created_at",
            "id",
            "model",
            "project_id",
            "project_name",
            "title",
            "user_id",
        ]);
    });

    it("answers the new four-argument call with the wider, email-aware set", async () => {
        const current = await admin.rpc("get_chats_overview", {
            p_user_id: callerId,
            p_user_email: callerEmail,
            p_limit: null,
            p_offset: 0,
        });

        expect(current.error).toBeNull();
        expect(titlesFrom(current.data)).toEqual(
            [
                "inGrantedProject",
                "inMyProject",
                "inSharedOrgProject",
                "mine",
                "sharedDirectly",
            ].sort(),
        );
        const row = (current.data as Record<string, unknown>[]).find(
            (r) => r.id === chats.mine,
        );
        expect(row?.is_owner).toBe(true);

        // Every row must also SAY what the caller may do with it. is_owner
        // alone was not enough: the client's roleFrom() falls back to
        // "member" for any non-owned row without an access_role, so the
        // sidebar offered viewers renames the server refuses and refused
        // admins deletes the server accepts. The role served here is the
        // same verdict the WHERE clause filtered on — one branch each:
        const roleOf = (id: string) =>
            (current.data as Record<string, unknown>[]).find((r) => r.id === id)
                ?.access_role;
        expect(roleOf(chats.mine)).toBe("admin"); // chat creator
        expect(roleOf(chats.inMyProject)).toBe("admin"); // project creator
        expect(roleOf(chats.inSharedOrgProject)).toBe("member"); // org member
        expect(roleOf(chats.inGrantedProject)).toBe("member"); // grant role
        expect(roleOf(chats.sharedDirectly)).toBe("member"); // chat share list
    });

    it("keeps the wrapper's paging identical to the new function's", async () => {
        // The wrapper delegates rather than re-implementing, so the clamp
        // (`greatest(1, least(p_limit, 100))`) lives in exactly one place.
        const page = await admin.rpc("get_chats_overview", {
            p_user_id: callerId,
            p_limit: 1,
            p_offset: 0,
        });
        expect(page.error).toBeNull();
        expect((page.data as unknown[]).length).toBe(1);
    });
});
