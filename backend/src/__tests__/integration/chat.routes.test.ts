import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// Hoisted mock fns so the vi.mock factories below (which are themselves
// hoisted above the imports) can reference them.
const { runLLMStream } = vi.hoisted(() => ({
    runLLMStream: vi.fn(),
}));

// Mock the env validation module — mirrors health.test.ts so the app factory
// can construct its rate limiters without real env vars present.
// A permissive, chainable Supabase stub. Every query-builder method returns the
// same object (so arbitrary chains work), the object is awaitable (thenable),
// and the terminal single()/maybeSingle() resolve to a chat row. The chat
// routes only read `.id`/`.title` and check `.error`, so this is enough to let
// a request flow through chat creation and message inserts without real IO.
function makeQuery() {
    const result = { data: { id: "chat-1", title: null }, error: null };
    const q: Record<string, unknown> = {};
    const chain = [
        "select", "insert", "update", "delete", "upsert",
        "eq", "neq", "in", "is", "or", "lt", "gt", "gte", "lte",
        "filter", "order", "limit", "range", "contains",
    ];
    for (const m of chain) q[m] = vi.fn(() => q);
    q.single = vi.fn(() => Promise.resolve(result));
    q.maybeSingle = vi.fn(() => Promise.resolve(result));
    q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject);
    return q;
}

function mockSupabase() {
    return {
        from: vi.fn(() => makeQuery()),
        rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
        auth: {
            getUser: () =>
                Promise.resolve({ data: { user: { id: "u1" } }, error: null }),
        },
    };
}

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => mockSupabase()),
}));

// Authenticate every request as user "u1" without exercising the real Supabase
// JWT path. requireMfaIfEnrolled must be exported too — userRouter (mounted by
// the app factory) imports it at module load.
vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "u1@test.local";
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

// Keep the real spotlight/annotation/error helpers (the failure-path test
// relies on the genuine isAbortError + AssistantStreamError behavior) but
// stub the functions that would otherwise hit the DB or the LLM.
vi.mock("../../lib/chat", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../lib/chat")>();
    return {
        ...actual,
        buildDocContext: vi.fn(async () => ({ docIndex: {}, docStore: {} })),
        enrichWithPriorEvents: vi.fn(async (messages: unknown) => messages),
        buildWorkflowStore: vi.fn(async () => ({})),
        buildMessages: vi.fn(() => []),
        runLLMStream: (...args: unknown[]) => runLLMStream(...args),
    };
});

vi.mock("../../lib/userSettings", () => ({
    getUserModelSettings: vi.fn(async () => ({
        legal_research_us: false,
        title_model: "test-model",
        api_keys: {},
    })),
    getUserApiKeys: vi.fn(async () => ({})),
}));

import { app } from "../../app";

const VALID_BODY = { messages: [{ role: "user", content: "hello" }] };

describe("POST /chat — streaming", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        runLLMStream.mockResolvedValue({
            fullText: "hi there",
            events: [],
            citations: [],
        });
    });

    it("streams SSE when the stream succeeds", async () => {
        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toContain("text/event-stream");
        expect(res.text).toContain('"type":"chat_id"');
    });

    it("surfaces a stream failure as an in-stream error event", async () => {
        runLLMStream.mockRejectedValue(new Error("upstream LLM failure"));

        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send(VALID_BODY);

        // Headers were already flushed (200) before the stream threw, so the
        // failure surfaces as an in-stream error event, not an HTTP error code.
        expect(res.status).toBe(200);
        expect(res.text).toContain('"type":"error"');
    });

    it("returns 400 on an empty messages array (never starts a stream)", async () => {
        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({ messages: [] });

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty("detail");
        expect(runLLMStream).not.toHaveBeenCalled();
    });

    it("returns 400 when messages is missing entirely", async () => {
        const res = await request(app)
            .post("/chat")
            .set("Authorization", "Bearer test")
            .send({});

        expect(res.status).toBe(400);
        expect(runLLMStream).not.toHaveBeenCalled();
    });
});
