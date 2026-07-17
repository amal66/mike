import { createOpenAIEmbeddingProvider } from "./openai";
import { createGeminiEmbeddingProvider } from "./gemini";
import {
    registerEmbeddingProvider,
    findEmbeddingProviderForModel,
    type EmbeddingProviderAdapter,
} from "./registry";

export * from "./registry";

// Default embedding model. The whole deployment pins ONE model
// (EMBEDDING_MODEL) + ONE width (EMBEDDING_DIMENSION) because a vector(N)
// column has a single fixed N; see the migration's header for why.
const DEFAULT_CLOUD_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_EMBEDDING_DIMENSION = 768;

/** Column width the adapters emit and the migration pins vector(N) to. */
export function resolveEmbeddingDimension(
    env: NodeJS.ProcessEnv = process.env,
): number {
    const raw = env.EMBEDDING_DIMENSION;
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_EMBEDDING_DIMENSION;
}

/**
 * The single embedding model this deployment ingests + searches with. Explicit
 * EMBEDDING_MODEL wins; otherwise the cloud default.
 */
export function resolveEmbeddingModel(
    env: NodeJS.ProcessEnv = process.env,
): string {
    if (env.EMBEDDING_MODEL?.trim()) return env.EMBEDDING_MODEL.trim();
    return DEFAULT_CLOUD_EMBEDDING_MODEL;
}

/**
 * Register the built-in embedding providers (OpenAI + Gemini).
 *
 * Reads process.env directly so importing this module doesn't force full env
 * validation — it loads in many unit tests. `env` is injectable so gating can
 * be exercised against a controlled environment.
 */
export function registerBuiltinEmbeddingProviders(
    env: NodeJS.ProcessEnv = process.env,
): void {
    const dimensions = resolveEmbeddingDimension(env);
    const model = resolveEmbeddingModel(env);

    registerEmbeddingProvider(createOpenAIEmbeddingProvider({ dimensions, model }));
    registerEmbeddingProvider(createGeminiEmbeddingProvider({ dimensions, model }));
}

registerBuiltinEmbeddingProviders();

/**
 * Resolve the adapter for the deployment's embedding model, or undefined when
 * none is registered. Callers degrade gracefully rather than error the chat
 * turn.
 */
export function getActiveEmbeddingProvider(
    env: NodeJS.ProcessEnv = process.env,
): EmbeddingProviderAdapter | undefined {
    return findEmbeddingProviderForModel(resolveEmbeddingModel(env));
}
