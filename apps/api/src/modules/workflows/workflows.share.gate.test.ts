import { describe, expect, it } from "vitest";
import { createFakeSupabase } from "../../lib/dms/__tests__/fakeDb";
import { shareWorkflow } from "./workflows.service";

// Integration-style coverage of the share-gate wired into shareWorkflow: the
// guard runs before the ownership check, so a non-Mike recipient is rejected
// with a 400-shaped result and no share row is written.
describe("shareWorkflow share-gate", () => {
    function seed() {
        return createFakeSupabase({
            user_profiles: [
                { user_id: "owner", email: "owner@example.com" },
                { user_id: "member", email: "member@example.com" },
            ],
            workflows: [
                { id: "wf1", user_id: "owner", is_system: false },
            ],
            workflow_shares: [],
        });
    }

    it("rejects sharing to an email that is not a Mike user", async () => {
        const db = seed();
        const result = await shareWorkflow(db as any, {
            workflowId: "wf1",
            userId: "owner",
            userEmail: "owner@example.com",
            emails: ["stranger@example.com"],
            allow_edit: false,
        });
        expect(result).toEqual({
            ok: false,
            kind: "missing_user",
            detail: "stranger@example.com does not belong to a Mike user.",
        });
        expect(db._tables.workflow_shares).toHaveLength(0);
    });

    it("allows sharing to an existing Mike user", async () => {
        const db = seed();
        const result = await shareWorkflow(db as any, {
            workflowId: "wf1",
            userId: "owner",
            userEmail: "owner@example.com",
            emails: ["member@example.com"],
            allow_edit: true,
        });
        expect(result).toEqual({ ok: true });
        expect(db._tables.workflow_shares).toHaveLength(1);
        expect(db._tables.workflow_shares[0]).toMatchObject({
            workflow_id: "wf1",
            shared_with_email: "member@example.com",
            allow_edit: true,
        });
    });
});
