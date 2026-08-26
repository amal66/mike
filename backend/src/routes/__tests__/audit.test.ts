import { describe, it, expect } from "vitest";
import {
    csvCell,
    escapeLikePattern,
    parseQuery,
    queryEvents,
    accessibleProjectIds,
} from "../audit";

// ---------------------------------------------------------------------------
// csvCell — spreadsheet formula-injection escaping (F3)
// ---------------------------------------------------------------------------

describe("csvCell", () => {
    it("prefixes a single quote to values that begin with a formula trigger", () => {
        for (const trigger of ["=", "+", "-", "@", "\t", "\r"]) {
            const payload = `${trigger}HYPERLINK("http://evil","x")`;
            const cell = csvCell(payload);
            // Leading quote neutralizes evaluation; the whole value is then
            // quoted because it contains characters requiring CSV quoting.
            expect(cell.startsWith(`"'${trigger}`)).toBe(true);
        }
    });

    it("neutralizes a bare leading = even without other special chars", () => {
        expect(csvCell("=1")).toBe("'=1");
    });

    it("quotes and escapes embedded quotes, commas, and newlines", () => {
        expect(csvCell("a,b")).toBe('"a,b"');
        expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
        expect(csvCell("line1\r\nline2")).toBe('"line1\r\nline2"');
    });

    it("leaves ordinary values untouched and renders null as empty", () => {
        expect(csvCell("brief.docx")).toBe("brief.docx");
        expect(csvCell(null)).toBe("");
        expect(csvCell(undefined)).toBe("");
    });
});

// ---------------------------------------------------------------------------
// parseQuery — page clamping (F7) + date validation (F8)
// ---------------------------------------------------------------------------

describe("parseQuery", () => {
    it("clamps an absurd page so the offset can't overflow", () => {
        const result = parseQuery({ page: "99999999999999" }, 50);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.query.page).toBe(100_000);
            // offset stays well within Postgres' integer range.
            expect((result.query.page - 1) * result.query.limit).toBeLessThan(
                2_147_483_647,
            );
        }
    });

    it("floors non-positive or non-numeric pages to 1", () => {
        for (const page of ["0", "-5", "abc", ""]) {
            const result = parseQuery({ page }, 50);
            expect(result.ok && result.query.page).toBe(1);
        }
    });

    it("rejects from/to that are not bare YYYY-MM-DD", () => {
        expect(parseQuery({ to: "2026-07-30T12:00:00Z" }, 50)).toEqual({
            ok: false,
            error: expect.stringContaining("to"),
        });
        expect(parseQuery({ from: "not-a-date" }, 50)).toEqual({
            ok: false,
            error: expect.stringContaining("from"),
        });
    });

    it("accepts well-formed dates and trims free-text filters", () => {
        const result = parseQuery(
            {
                from: "2026-07-01",
                to: "2026-07-31",
                q: "  hello  ",
                action: " chat.message ",
                status: " completed ",
                surface: " project ",
                sort_by: "title",
                sort_dir: "asc",
            },
            50,
        );
        expect(result).toMatchObject({
            ok: true,
            query: {
                from: "2026-07-01",
                to: "2026-07-31",
                q: "hello",
                action: "chat.message",
                status: "completed",
                surface: "project",
                sortBy: "title",
                sortDirection: "asc",
            },
        });
    });

    it("rejects unsupported sort fields and directions", () => {
        expect(parseQuery({ sort_by: "detail" }, 50)).toEqual({
            ok: false,
            error: "Invalid audit sort field",
        });
        expect(parseQuery({ sort_dir: "sideways" }, 50)).toEqual({
            ok: false,
            error: "Invalid audit sort direction",
        });
    });
});

// ---------------------------------------------------------------------------
// queryEvents / accessibleProjectIds — visibility scoping
// ---------------------------------------------------------------------------

/**
 * Chainable Supabase mock.
 *
 * `owned` answers the `projects` lookup (.eq on user_id) and `shared` answers
 * the `project_access_grants` lookup, which is where direct sharing actually
 * lives. `mirrorOnly` seeds projects that carry the caller's address in the
 * legacy `projects.shared_with` mirror WITHOUT a grant: they are what a
 * regression to mirror-based authorization would let through, and the mock
 * records any containment query so such a regression is visible rather than
 * merely wrong.
 *
 * The builder deliberately has no .contains: shared_with is jsonb, and
 * supabase-js .contains serializes arrays as PgArray, which Postgres rejects.
 */
function makeDb(
    owned: string[],
    shared: string[],
    events: Record<string, unknown>[] = [],
    profiles: Record<string, unknown>[] = [],
    mirrorOnly: string[] = [],
) {
    const calls: {
        or?: string;
        eq: [string, unknown][];
        order?: [string, { ascending: boolean; nullsFirst: boolean }];
        ilike?: [string, string];
        profileUserIds?: string[];
        sharedFilter?: [string, string, string];
        grantEmail?: unknown;
    } = { eq: [] };

    function projectsBuilder() {
        let mode: "owned" | "mirror" = "owned";
        const b: any = {
            select: () => b,
            eq: () => {
                mode = "owned";
                return b;
            },
            filter: (column: string, op: string, value: string) => {
                calls.sharedFilter = [column, op, value];
                mode = "mirror";
                return b;
            },
            then: (resolve: (v: { data: { id: string }[] }) => unknown) =>
                Promise.resolve({
                    data: (mode === "owned" ? owned : mirrorOnly).map((id) => ({
                        id,
                    })),
                }).then(resolve),
        };
        return b;
    }

    function grantsBuilder() {
        const b: any = {
            select: () => b,
            eq: (column: string, value: unknown) => {
                if (column === "email") calls.grantEmail = value;
                return b;
            },
            then: (
                resolve: (v: { data: { project_id: string }[] }) => unknown,
            ) =>
                Promise.resolve({
                    data: shared.map((id) => ({ project_id: id })),
                }).then(resolve),
        };
        return b;
    }

    function auditBuilder() {
        const b: any = {
            select: () => b,
            or: (expr: string) => {
                calls.or = expr;
                return b;
            },
            eq: (col: string, val: unknown) => {
                calls.eq.push([col, val]);
                return b;
            },
            ilike: (column: string, pattern: string) => {
                calls.ilike = [column, pattern];
                return b;
            },
            gte: () => b,
            lte: () => b,
            order: (
                column: string,
                options: { ascending: boolean; nullsFirst: boolean },
            ) => {
                calls.order = [column, options];
                return b;
            },
            range: () =>
                Promise.resolve({
                    data: events,
                    error: null,
                    count: events.length,
                }),
        };
        return b;
    }

    function profilesBuilder() {
        const b: any = {
            select: () => b,
            in: (_column: string, userIds: string[]) => {
                calls.profileUserIds = userIds;
                return Promise.resolve({ data: profiles, error: null });
            },
        };
        return b;
    }

    const db = {
        from(table: string) {
            if (table === "projects") return projectsBuilder();
            if (table === "project_access_grants") return grantsBuilder();
            if (table === "user_profiles") return profilesBuilder();
            return auditBuilder();
        },
    };
    return { db: db as any, calls };
}

describe("queryEvents visibility scoping", () => {
    const query = {
        page: 1,
        limit: 50,
        sortBy: "created_at",
        sortDirection: "desc",
    } as const;

    it("scopes to own events OR accessible project events (owned + shared)", async () => {
        const { db, calls } = makeDb(["p-own"], ["p-shared"]);
        await queryEvents(db, "u1", "u1@example.com", query);
        expect(calls.or).toBe("user_id.eq.u1,project_id.in.(p-own,p-shared)");
        expect(calls.eq).toEqual([]);
    });

    it("falls back to own-events-only when no projects are accessible", async () => {
        const { db, calls } = makeDb([], []);
        await queryEvents(db, "u1", "u1@example.com", query);
        expect(calls.or).toBeUndefined();
        expect(calls.eq).toContainEqual(["user_id", "u1"]);
    });

    it("de-duplicates owned and shared project ids", async () => {
        const both = await accessibleProjectIds(
            makeDb(["p1", "p2"], ["p2", "p3"]).db,
            "u1",
            "u1@example.com",
        );
        expect([...both].sort()).toEqual(["p1", "p2", "p3"]);
    });

    it("looks direct sharing up by normalized email in the grant table", async () => {
        const { db, calls } = makeDb([], ["p-shared"]);
        await accessibleProjectIds(db, "u1", " U1@Example.com ");
        expect(calls.grantEmail).toBe("u1@example.com");
        // Grants are the source of truth; the mirror is never consulted.
        expect(calls.sharedFilter).toBeUndefined();
    });

    it("admits a grant holder and refuses an address that is only in the mirror", async () => {
        // `projects.shared_with` is rewritten from the grants after every
        // mutation, so in the happy path the two agree — which is exactly why
        // reading the mirror looked harmless. It is not the same statement:
        // the mirror was backfilled from legacy rows by migration _03, is
        // still writable directly, and is declared display-only. An audit
        // trail is not something a display column gets to hand out.
        const { db } = makeDb([], ["p-granted"], [], [], ["p-mirror-only"]);
        const visible = await accessibleProjectIds(db, "u1", "u1@example.com");
        expect(visible).toContain("p-granted");
        expect(visible).not.toContain("p-mirror-only");
    });

    it("applies categorical filters and the requested sort", async () => {
        const { db, calls } = makeDb([], []);
        await queryEvents(db, "u1", "u1@example.com", {
            ...query,
            action: "document.uploaded",
            status: "completed",
            surface: "project",
            q: "agreement\\draft_100%",
            sortBy: "title",
            sortDirection: "asc",
        });

        expect(calls.eq).toEqual(
            expect.arrayContaining([
                ["user_id", "u1"],
                ["action", "document.uploaded"],
                ["status", "completed"],
                ["surface", "project"],
            ]),
        );
        expect(calls.order).toEqual([
            "title",
            { ascending: true, nullsFirst: false },
        ]);
        expect(calls.ilike).toEqual([
            "title",
            "%agreement\\\\draft\\_100\\%%",
        ]);
    });

    it("resolves display names for only the users on the requested page", async () => {
        const events = [
            {
                id: "event-1",
                user_id: "u1",
                user_email: "one@example.com",
            },
            {
                id: "event-2",
                user_id: "u2",
                user_email: "two@example.com",
            },
        ];
        const { db, calls } = makeDb([], [], events, [
            { user_id: "u1", display_name: "  Alex Lawyer  " },
        ]);

        const result = await queryEvents(db, "u1", "one@example.com", query);

        expect(calls.profileUserIds).toEqual(["u1", "u2"]);
        expect(result.data).toEqual([
            {
                id: "event-1",
                user_email: "one@example.com",
                user_display_name: "Alex Lawyer",
            },
            {
                id: "event-2",
                user_email: "two@example.com",
                user_display_name: null,
            },
        ]);
    });

    it("can skip profile resolution for the larger export query", async () => {
        const { db, calls } = makeDb(
            [],
            [],
            [{ id: "event-1", user_id: "u1", user_email: "one@example.com" }],
        );

        const result = await queryEvents(
            db,
            "u1",
            "one@example.com",
            query,
            false,
        );

        expect(calls.profileUserIds).toBeUndefined();
        expect(result.data).toEqual([
            {
                id: "event-1",
                user_email: "one@example.com",
                user_display_name: null,
            },
        ]);
    });
});
