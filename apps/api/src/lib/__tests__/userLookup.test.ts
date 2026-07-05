import { describe, expect, it } from "vitest";
import { createFakeSupabase } from "../dms/__tests__/fakeDb";
import {
    assertShareableEmails,
    findMissingUserEmails,
    findProfileUserByEmail,
    loadProfileUsersByEmail,
    syncProfileEmail,
} from "../userLookup";

// The mirror helpers only ever touch public.user_profiles, so the in-memory
// fakeDb (select/upsert/eq/in + await) exercises the real query shapes.
function seedProfiles(rows: { user_id: string; email: string; display_name?: string | null }[]) {
    return createFakeSupabase({
        user_profiles: rows.map((r) => ({
            user_id: r.user_id,
            email: r.email,
            display_name: r.display_name ?? null,
        })),
    });
}

describe("syncProfileEmail", () => {
    it("inserts a lowercased email for a new profile", async () => {
        const db = createFakeSupabase({ user_profiles: [] });
        const err = await syncProfileEmail(db as any, "u1", "Ada@Example.COM");
        expect(err).toBeNull();
        expect(db._tables.user_profiles).toHaveLength(1);
        expect(db._tables.user_profiles[0]).toMatchObject({
            user_id: "u1",
            email: "ada@example.com",
        });
    });

    it("updates the email on an existing profile (upsert on user_id)", async () => {
        const db = seedProfiles([
            { user_id: "u1", email: "old@example.com", display_name: "Ada" },
        ]);
        const err = await syncProfileEmail(db as any, "u1", "new@example.com");
        expect(err).toBeNull();
        expect(db._tables.user_profiles).toHaveLength(1);
        expect(db._tables.user_profiles[0]).toMatchObject({
            user_id: "u1",
            email: "new@example.com",
            display_name: "Ada", // untouched
        });
    });

    it("is a no-op (null) for a blank/missing email and never throws", async () => {
        const db = createFakeSupabase({ user_profiles: [] });
        expect(await syncProfileEmail(db as any, "u1", "   ")).toBeNull();
        expect(await syncProfileEmail(db as any, "u1", null)).toBeNull();
        expect(await syncProfileEmail(db as any, "u1", undefined)).toBeNull();
        expect(db._tables.user_profiles).toHaveLength(0);
    });

    it("returns an Error instead of throwing when the db rejects", async () => {
        const throwingDb = {
            from() {
                throw new Error("connection lost");
            },
        };
        const err = await syncProfileEmail(throwingDb as any, "u1", "a@b.com");
        expect(err).toBeInstanceOf(Error);
        expect(err?.message).toBe("connection lost");
    });
});

describe("findProfileUserByEmail", () => {
    it("resolves a known email case-insensitively", async () => {
        const db = seedProfiles([
            { user_id: "u1", email: "ada@example.com", display_name: "Ada L" },
        ]);
        const user = await findProfileUserByEmail(db as any, "ADA@example.com");
        expect(user).toEqual({ email: "ada@example.com", display_name: "Ada L" });
    });

    it("returns null for an unknown or blank email", async () => {
        const db = seedProfiles([
            { user_id: "u1", email: "ada@example.com" },
        ]);
        expect(await findProfileUserByEmail(db as any, "nobody@x.com")).toBeNull();
        expect(await findProfileUserByEmail(db as any, "   ")).toBeNull();
    });
});

describe("findMissingUserEmails", () => {
    it("returns only emails with no matching profile, order + dedupe preserved", async () => {
        const db = seedProfiles([
            { user_id: "u1", email: "known@example.com" },
        ]);
        const missing = await findMissingUserEmails(db as any, [
            "First@Example.com",
            "known@example.com",
            "second@example.com",
            "FIRST@example.com", // dup of first (case-insensitive)
            "",
        ]);
        expect(missing).toEqual(["first@example.com", "second@example.com"]);
    });

    it("returns [] when every email is known", async () => {
        const db = seedProfiles([
            { user_id: "u1", email: "a@example.com" },
            { user_id: "u2", email: "b@example.com" },
        ]);
        expect(
            await findMissingUserEmails(db as any, ["A@example.com", "b@example.com"]),
        ).toEqual([]);
    });

    it("returns [] for an empty input without querying", async () => {
        const db = seedProfiles([]);
        expect(await findMissingUserEmails(db as any, [])).toEqual([]);
    });
});

describe("loadProfileUsersByEmail", () => {
    it("indexes profiles by email and by user_id, skipping blank emails", async () => {
        const db = seedProfiles([
            { user_id: "u1", email: "ada@example.com", display_name: "Ada" },
            { user_id: "u2", email: "GRACE@example.com", display_name: null },
            { user_id: "u3", email: "", display_name: "No Email" },
        ]);
        const { userByEmail, userById } = await loadProfileUsersByEmail(db as any);

        expect(userByEmail.get("ada@example.com")).toEqual({
            user_id: "u1",
            email: "ada@example.com",
            display_name: "Ada",
        });
        // stored value is lowercased on read
        expect(userByEmail.get("grace@example.com")?.user_id).toBe("u2");
        expect(userById.get("u2")?.display_name).toBeNull();
        // blank-email row is excluded from both maps
        expect(userById.has("u3")).toBe(false);
        expect(userByEmail.size).toBe(2);
    });
});

describe("assertShareableEmails (share-gate)", () => {
    it("allows when every email belongs to a Mike user", async () => {
        const db = seedProfiles([
            { user_id: "u1", email: "member@example.com" },
        ]);
        expect(await assertShareableEmails(db as any, ["member@example.com"])).toEqual({
            ok: true,
        });
    });

    it("rejects with the first offending email's detail", async () => {
        const db = seedProfiles([
            { user_id: "u1", email: "member@example.com" },
        ]);
        const result = await assertShareableEmails(db as any, [
            "member@example.com",
            "stranger@example.com",
        ]);
        expect(result).toEqual({
            ok: false,
            detail: "stranger@example.com does not belong to a Mike user.",
        });
    });

    it("allows an empty recipient list", async () => {
        const db = seedProfiles([]);
        expect(await assertShareableEmails(db as any, [])).toEqual({ ok: true });
    });
});
