import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static checks on the org RPCs' SQL.
//
// The visibility predicates in 20260902_03 are the SQL twins of lib/access.ts,
// and the mistakes below are invisible in review because the wrong version
// and the right version differ by one word. Exercising them
// properly needs a live Postgres (npm run test:stack), which does not run in
// `npm test` — so these read the shipped SQL and assert the shape directly.
// A grep-shaped test is a poor substitute for executing the query, and a very
// good substitute for nothing.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "../../..");
const SOURCES = {
    "migrations/20260902_03_org_rpcs.sql": readFileSync(
        resolve(ROOT, "migrations/20260902_03_org_rpcs.sql"),
        "utf8",
    ),
    "schema.sql": readFileSync(resolve(ROOT, "schema.sql"), "utf8"),
};

describe.each(Object.entries(SOURCES))("%s", (_name, sql) => {
    it("compares p_user_email case-insensitively everywhere", () => {
        // Emails are stored lowercase (project_access_grants carries a
        // lowercase CHECK, migration _03 normalized
        // tabular_reviews.shared_with), and every predicate lower()s the
        // caller's address before comparing — except two arms that did not,
        // so a caller whose account email is "B@Example.com" was invisible to
        // exactly those two branches while every sibling branch admitted
        // them. List and detail disagreeing about the same review is the bug
        // class this PR exists to close.
        //
        // Rather than enumerate the legitimate uses (declarations,
        // pass-throughs, coalesce guards), this looks only for the two shapes
        // that actually compare a stored value against the raw parameter.
        const offenders = sql
            .split("\n")
            .map((line, index) => [index + 1, line.trim()] as const)
            .filter(
                ([, line]) =>
                    /@>\s*jsonb_build_array\(\s*p_user_email\s*\)/.test(line) ||
                    /(=|<>|like|ilike)\s*p_user_email\b/i.test(line),
            );
        expect(offenders).toEqual([]);
    });

    it("lets an org member edit an org workflow", () => {
        // The org arm of both get_workflows_overview overloads reported
        // `false as allow_edit`, so a firm's shared workflow was read-only for
        // every member of the firm including its admins. The list's
        // affordances and routes/workflows.ts's resolveWorkflowAccess have to
        // agree, or the UI offers an edit the server then refuses.
        const orgArms = [
            ...sql.matchAll(/org_shared as \(([\s\S]*?)\n  \),/g),
        ].map(([, body]) => body);
        // Only the arms that project an allow_edit column: the filter-options
        // RPC has an org arm too, and it returns facets, not capabilities.
        const editArms = orgArms.filter((arm) => /as allow_edit/.test(arm));
        expect(editArms.length).toBeGreaterThan(0);
        for (const arm of editArms) {
            expect(arm).toContain("true as allow_edit");
            expect(arm).not.toContain("false as allow_edit");
            // Editing is a member capability; ownership is provenance and
            // still gates share/delete.
            expect(arm).toContain("false as is_owner");
        }
    });

    it("never offers NULL as an owner-filter option", () => {
        // `on delete set null` means a project can outlive its creator with
        // user_id = NULL. Emitting that as a dropdown option produced an entry
        // whose value is null — and selecting it made the guard
        // `p_owner_user_id is null or p.user_id::text = p_owner_user_id` true
        // for every row, so the filter silently disabled itself rather than
        // narrowing anything.
        const cte = sql.slice(
            sql.indexOf("distinct_owners as ("),
            sql.indexOf("owner_options as ("),
        );
        expect(cte).toContain("distinct_owners as (");
        expect(cte).toMatch(/where\s+vp\.user_id\s+is\s+not\s+null/);
    });
});

it("the migration and schema.sql agree on both predicates", () => {
    // A fresh install and an upgraded deployment must converge; CI's
    // schema-drift job checks this against a real database, and this catches
    // the common half of it (editing one file and forgetting the other)
    // before anyone waits for a database.
    const shape = (sql: string) => ({
        loweredContainment: (
            sql.match(/shared_with @> jsonb_build_array\(lower\(p_user_email\)\)/g) ??
            []
        ).length,
        bareContainment: (
            sql.match(/shared_with @> jsonb_build_array\(p_user_email\)/g) ?? []
        ).length,
        ownersExcludeNull: /distinct vp\.user_id\s+from visible_projects vp\s+where vp\.user_id is not null/.test(
            sql,
        ),
    });
    const migration = shape(
        SOURCES["migrations/20260902_03_org_rpcs.sql"],
    );
    expect(migration.bareContainment).toBe(0);
    expect(migration.loweredContainment).toBeGreaterThan(0);
    expect(shape(SOURCES["schema.sql"])).toEqual(migration);
});
