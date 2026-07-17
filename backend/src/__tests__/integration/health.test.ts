import { describe, it, expect, vi } from "vitest";
import request from "supertest";

// Mock Supabase before importing the app so createServerSupabase() never
// attempts a real network connection during tests.
vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => mockSupabase()),
}));

function mockSupabase() {
    return {
        from: () => ({
            select: () => ({
                limit: () => Promise.resolve({ data: [], error: null }),
            }),
        }),
        auth: {
            getUser: () => Promise.resolve({ data: { user: null }, error: null }),
        },
    };
}

// Vitest hoists vi.mock() calls before all imports, so this regular import
// will receive the mocked Supabase client even though it appears after the
// vi.mock() calls in source order.
import { app } from "../../app";

describe("GET /health", () => {
    it("returns 200 with { ok: true }", async () => {
        const res = await request(app).get("/health");
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
    });
});

describe("requireAuth middleware", () => {
    it("rejects requests with no Authorization header (401)", async () => {
        const res = await request(app).get("/chat");
        expect(res.status).toBe(401);
        expect(res.body).toHaveProperty("detail");
    });

    it("rejects requests with a non-Bearer Authorization header (401)", async () => {
        const res = await request(app)
            .get("/chat")
            .set("Authorization", "Basic dXNlcjpwYXNz");
        expect(res.status).toBe(401);
    });
});

describe("404 handling", () => {
    it("returns 404 for unknown routes", async () => {
        const res = await request(app).get("/this-route-does-not-exist");
        expect(res.status).toBe(404);
    });
});
