import { beforeEach, describe, expect, it } from "vitest";

import {
    registerBuiltinEmbeddingProviders,
    resolveEmbeddingModel,
    resolveEmbeddingDimension,
    getActiveEmbeddingProvider,
} from "../index";
import {
    registerEmbeddingProvider,
    getEmbeddingProvider,
    findEmbeddingProviderForModel,
    _resetEmbeddingRegistryForTesting,
    type EmbeddingProviderAdapter,
} from "../registry";

// registerBuiltinEmbeddingProviders ran once at import with the real env; reset
// before each case and re-register against a controlled env for determinism.
beforeEach(() => _resetEmbeddingRegistryForTesting());

function fakeAdapter(id: string, models: string[]): EmbeddingProviderAdapter {
    const set = new Set(models);
    return {
        id,
        matchesModel: (m) => set.has(m),
        dimensions: 768,
        models,
        embed: async (texts) => texts.map(() => [0, 0, 0]),
    };
}

describe("embedding registry", () => {
    it("registers, finds by model, and resets", async () => {
        const adapter = fakeAdapter("fake", ["fake-embed-1"]);
        registerEmbeddingProvider(adapter);
        expect(getEmbeddingProvider("fake")).toBe(adapter);
        expect(findEmbeddingProviderForModel("fake-embed-1")).toBe(adapter);
        expect(findEmbeddingProviderForModel("unknown")).toBeUndefined();
        // The fake adapter is deterministic and makes no network call.
        expect(await adapter.embed(["a", "b"])).toEqual([[0, 0, 0], [0, 0, 0]]);

        _resetEmbeddingRegistryForTesting();
        expect(getEmbeddingProvider("fake")).toBeUndefined();
    });

    it("registers the built-in cloud embedding providers", () => {
        registerBuiltinEmbeddingProviders({});
        expect(getEmbeddingProvider("openai-embed")).toBeDefined();
        expect(getEmbeddingProvider("gemini-embed")).toBeDefined();
    });
});

describe("resolveEmbeddingModel / resolveEmbeddingDimension", () => {
    it("defaults to the cloud model", () => {
        expect(resolveEmbeddingModel({})).toBe("text-embedding-3-small");
    });

    it("honours an explicit EMBEDDING_MODEL override", () => {
        expect(resolveEmbeddingModel({ EMBEDDING_MODEL: "text-embedding-3-large" })).toBe(
            "text-embedding-3-large",
        );
    });

    it("defaults dimension to 768 and honours EMBEDDING_DIMENSION", () => {
        expect(resolveEmbeddingDimension({})).toBe(768);
        expect(resolveEmbeddingDimension({ EMBEDDING_DIMENSION: "1536" })).toBe(1536);
        expect(resolveEmbeddingDimension({ EMBEDDING_DIMENSION: "bad" })).toBe(768);
    });

    it("getActiveEmbeddingProvider resolves the deployment model to an adapter", () => {
        registerBuiltinEmbeddingProviders({});
        expect(getActiveEmbeddingProvider({})?.id).toBe("openai-embed");
    });
});
