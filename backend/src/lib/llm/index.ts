import { isAirgapped } from "../airgap";
import { streamClaude, completeClaudeText } from "./claude";
import { streamGemini, completeGeminiText } from "./gemini";
import { streamOpenAI, completeOpenAIText } from "./openai";
import { providerForModel } from "./models";
import type { StreamChatParams, StreamChatResult, UserApiKeys } from "./types";

export * from "./types";
export * from "./models";

/** Thrown when a requested model has no available provider (e.g. a cloud model
 *  in air-gapped mode). Carries an attributed, user-facing message. */
export class ModelUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ModelUnavailableError";
    }
}

/**
 * In air-gapped mode the cloud providers (claude/gemini/openai) must never be
 * dispatched — this is the in-code half of the "no external egress" guarantee
 * (network isolation is the other half). Every provider this dispatcher knows
 * is a cloud provider, so AIRGAPPED=true refuses dispatch outright with an
 * explicit, attributed error rather than an opaque downstream failure. Local
 * model serving (Ollama) plugs in via the provider-registry / local-LLM PRs.
 */
function assertModelAvailable(model: string): void {
    if (!isAirgapped()) return;
    throw new ModelUnavailableError(
        `Model "${model}" is unavailable in air-gapped mode — only local models are served. Configure a local (Ollama) model.`,
    );
}

export async function streamChatWithTools(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    assertModelAvailable(params.model);
    const provider = providerForModel(params.model);
    if (provider === "claude") return streamClaude(params);
    if (provider === "openai") return streamOpenAI(params);
    return streamGemini(params);
}

export async function completeText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: UserApiKeys;
}): Promise<string> {
    assertModelAvailable(params.model);
    const provider = providerForModel(params.model);
    if (provider === "claude") return completeClaudeText(params);
    if (provider === "openai") return completeOpenAIText(params);
    return completeGeminiText(params);
}
