import { createMikeApiClient, type AuthHeaderProvider } from "@mike/api-client";

export * from "@mike/core";
export * from "@mike/api-client";

export type MikeClientOptions = {
    baseUrl?: string;
    /**
     * A bearer credential. This can be a programmatic Mike API key
     * (`mike_sk_...`, created on the Developer settings page) or a Supabase
     * session JWT. Either way it is sent as `Authorization: Bearer <apiKey>`.
     */
    apiKey?: string;
    getAuthHeaders?: AuthHeaderProvider;
    fetchImpl?: typeof fetch;
};

export class MikeClient {
    private readonly client: ReturnType<typeof createMikeApiClient>;

    constructor(options: MikeClientOptions = {}) {
        this.client = createMikeApiClient({
            baseUrl: options.baseUrl,
            fetchImpl: options.fetchImpl,
            getAuthHeaders:
                options.getAuthHeaders ??
                (async (): Promise<Record<string, string>> =>
                    options.apiKey
                        ? { Authorization: `Bearer ${options.apiKey}` }
                        : {}),
        });
    }

    projects = {
        list: (
            ...args: Parameters<
                ReturnType<typeof createMikeApiClient>["projects"]["list"]
            >
        ) => this.client.projects.list(...args),
        create: (
            ...args: Parameters<
                ReturnType<typeof createMikeApiClient>["projects"]["create"]
            >
        ) => this.client.projects.create(...args),
        get: (
            ...args: Parameters<
                ReturnType<typeof createMikeApiClient>["projects"]["get"]
            >
        ) => this.client.projects.get(...args),
        update: (
            ...args: Parameters<
                ReturnType<typeof createMikeApiClient>["projects"]["update"]
            >
        ) => this.client.projects.update(...args),
        delete: (
            ...args: Parameters<
                ReturnType<typeof createMikeApiClient>["projects"]["delete"]
            >
        ) => this.client.projects.delete(...args),
    };

    chats = {
        create: (
            ...args: Parameters<
                ReturnType<typeof createMikeApiClient>["chats"]["create"]
            >
        ) => this.client.chats.create(...args),
        list: (
            ...args: Parameters<
                ReturnType<typeof createMikeApiClient>["chats"]["list"]
            >
        ) => this.client.chats.list(...args),
        get: (
            ...args: Parameters<
                ReturnType<typeof createMikeApiClient>["chats"]["get"]
            >
        ) => this.client.chats.get(...args),
    };

    documents = {
        uploadToProject: (
            ...args: Parameters<
                ReturnType<
                    typeof createMikeApiClient
                >["documents"]["uploadToProject"]
            >
        ) => this.client.documents.uploadToProject(...args),
        uploadStandalone: (
            ...args: Parameters<
                ReturnType<
                    typeof createMikeApiClient
                >["documents"]["uploadStandalone"]
            >
        ) => this.client.documents.uploadStandalone(...args),
    };

    /** Manage programmatic API keys (requires a logged-in user session). */
    apiKeys = {
        list: (
            ...args: Parameters<
                ReturnType<typeof createMikeApiClient>["apiKeys"]["list"]
            >
        ) => this.client.apiKeys.list(...args),
        create: (
            ...args: Parameters<
                ReturnType<typeof createMikeApiClient>["apiKeys"]["create"]
            >
        ) => this.client.apiKeys.create(...args),
        revoke: (
            ...args: Parameters<
                ReturnType<typeof createMikeApiClient>["apiKeys"]["revoke"]
            >
        ) => this.client.apiKeys.revoke(...args),
    };

    /** Manage webhook endpoints and inspect deliveries. */
    webhooks = {
        listEventTypes: (
            ...args: Parameters<
                ReturnType<
                    typeof createMikeApiClient
                >["webhooks"]["listEventTypes"]
            >
        ) => this.client.webhooks.listEventTypes(...args),
        listEndpoints: (
            ...args: Parameters<
                ReturnType<
                    typeof createMikeApiClient
                >["webhooks"]["listEndpoints"]
            >
        ) => this.client.webhooks.listEndpoints(...args),
        createEndpoint: (
            ...args: Parameters<
                ReturnType<
                    typeof createMikeApiClient
                >["webhooks"]["createEndpoint"]
            >
        ) => this.client.webhooks.createEndpoint(...args),
        deleteEndpoint: (
            ...args: Parameters<
                ReturnType<
                    typeof createMikeApiClient
                >["webhooks"]["deleteEndpoint"]
            >
        ) => this.client.webhooks.deleteEndpoint(...args),
        listDeliveries: (
            ...args: Parameters<
                ReturnType<
                    typeof createMikeApiClient
                >["webhooks"]["listDeliveries"]
            >
        ) => this.client.webhooks.listDeliveries(...args),
    };
}
