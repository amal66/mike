import { describe, it, expect, beforeEach, vi } from "vitest";

// Offline module loading: mock supabase (no client is ever constructed here).
vi.mock("../../../supabase", () => ({ createServerSupabase: vi.fn() }));

import { runToolCalls } from "../toolDispatcher";
import type { DocStore, DocIndex, ToolCall } from "../../types";
import {
    registerEmbeddingProvider,
    _resetEmbeddingRegistryForTesting,
    type EmbeddingProviderAdapter,
} from "../../../llm/embeddings";

function fakeProvider(): EmbeddingProviderAdapter {
    return {
        id: "fake-embed",
        // Match whatever resolveEmbeddingModel() returns (the cloud default here).
        matchesModel: () => true,
        dimensions: 2,
        models: ["fake"],
        embed: async (texts) => texts.map(() => [0.1, 0.2]),
    };
}

type RpcArgs = Record<string, unknown>;

function makeFixture(opts: {
    matches: unknown[];
    onRpc?: (args: RpcArgs) => void;
}) {
    const db = {
        rpc: async (_name: string, args: RpcArgs) => {
            opts.onRpc?.(args);
            return { data: opts.matches, error: null };
        },
    };
    const docStore: DocStore = new Map([
        [
            "doc-0",
            { storage_path: "", file_type: "pdf", filename: "Contract.pdf" },
        ],
    ]);
    const docIndex: DocIndex = {
        "doc-0": { document_id: "DID-0", filename: "Contract.pdf" },
    };
    return { db, docStore, docIndex };
}

function searchCall(args: Record<string, unknown>): ToolCall {
    return {
        id: "call-1",
        function: {
            name: "search_documents",
            arguments: JSON.stringify(args),
        },
    };
}

async function runSearch(
    fixture: ReturnType<typeof makeFixture>,
    args: Record<string, unknown>,
) {
    return runToolCalls(
        [searchCall(args)],
        fixture.docStore,
        "u1",
        fixture.db as never,
        () => {},
        undefined,
        undefined,
        fixture.docIndex,
        undefined,
        undefined,
        null,
        undefined,
        {},
    );
}

beforeEach(() => {
    _resetEmbeddingRegistryForTesting();
    registerEmbeddingProvider(fakeProvider());
});

describe("search_documents tool", () => {
    it("embeds the query, scopes the search, and emits a citation reminder", async () => {
        let rpcArgs: RpcArgs | undefined;
        const fixture = makeFixture({
            matches: [
                {
                    document_id: "DID-0",
                    version_id: "v1",
                    chunk_index: 2,
                    content: "The indemnity clause is unlimited.",
                    page: 4,
                    distance: 0.12,
                },
            ],
            onRpc: (args) => (rpcArgs = args),
        });

        const res = await runSearch(fixture, { query: "indemnity" });

        // Query was embedded via the fake provider and serialized as a literal.
        expect(rpcArgs?.p_query_embedding).toBe("[0.1,0.2]");
        // Scoped to the chat's document ids (authz boundary).
        expect(rpcArgs?.p_document_ids).toEqual(["DID-0"]);

        const content = (res.toolResults[0] as { content: string }).content;
        expect(content).toContain("The indemnity clause is unlimited.");
        // Citation reminder maps document_id -> the doc-N label + filename + page.
        expect(content).toContain('"doc-0"');
        expect(content).toContain("Contract.pdf");
        expect(content).toContain("page 4");

        // Records one docsFound entry for the matched document.
        expect(res.docsFound).toEqual([
            { filename: "Contract.pdf", query: "indemnity", total_matches: 1 },
        ]);
    });

    it("returns an error result for an empty query", async () => {
        const fixture = makeFixture({ matches: [] });
        const res = await runSearch(fixture, { query: "   " });
        const content = (res.toolResults[0] as { content: string }).content;
        expect(content).toContain("query is required");
    });

    it("degrades gracefully when no embedding provider is available", async () => {
        _resetEmbeddingRegistryForTesting(); // leave the registry empty
        const fixture = makeFixture({ matches: [] });
        const res = await runSearch(fixture, { query: "anything" });
        const content = (res.toolResults[0] as { content: string }).content;
        expect(content).toContain("unavailable");
        // No matches recorded — the turn is not errored.
        expect(res.docsFound).toEqual([]);
    });
});
