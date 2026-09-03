import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["src/**/*.test.ts"],
        exclude: ["dist/**", "node_modules/**"],
        // Generous timeouts so cold-start module transform/import latency
        // can't cause spurious timeout failures on a cold CI runner. Warm
        // tests finish in ~1s; this only guards the pathological cold case —
        // it does not mask hangs.
        testTimeout: 20000,
        hookTimeout: 20000,
        coverage: {
            provider: "v8",
            reporter: ["text", "lcov"],
            include: ["src/lib/**", "src/modules/**"],
            // No-regression RATCHET floor, not a target. The measured set is
            // src/lib/** (the tested libs — access, storage keys/dispositions,
            // downloadTokens, userApiKeys, chat doc resolution, llm model
            // resolution, chat citations, documentVersions, userDataCleanup,
            // docxTrackedChanges, workflow catalog ingestion — AND the large,
            // lightly tested feature libs: courtlistener, mcp, chat tool
            // dispatch, llm providers, spreadsheet handling) PLUS
            // src/modules/** (every domain's route handlers and service
            // layers; the tabular extraction core moved here from lib/).
            // Widening the include grew the denominator by previously
            // unmeasured route/service code; the module split then added
            // service-level unit tests (tabular, uploads, chat, workflows
            // add-ons, models) and, after the 2026-09-14 rebase onto main,
            // main's own org-access, memory and connector suites now running
            // against the modules, which raised the measurement to 61.34%
            // statements, 52.31% branches, 66.28% functions, 63.97% lines.
            // The floors sit just below that — CI fails on a *drop* from
            // here. Floors only go up: when you add tests, raise them in the
            // same PR. Backlog + per-area status: docs/testing-coverage.md.
            thresholds: {
                statements: 61,
                branches: 52,
                functions: 66,
                lines: 63,
            },
        },
    },
});
