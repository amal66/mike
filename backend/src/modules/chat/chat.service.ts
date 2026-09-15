// Business logic + data-access for the chat module.
//
// These functions are the service layer behind chat.routes.ts. They take an
// explicit Supabase client (`db`) plus request-derived primitives, perform the
// chat orchestration / DB work, and RETURN values or typed error results. They
// never touch req/res — the thin route handlers map the results onto HTTP
// status codes, headers, and response bodies.
//
// IMPORTANT: the SSE streaming loop (header flush, runLLMStream, abort
// handling, assistant-message persistence) deliberately stays in the route —
// its ordering is delicate. Only the NON-streaming logic and the pre-stream
// DB preparation live here. `prepareChatStream` returns the prepared data the
// route needs to run the stream; it does not stream.

import type { Db } from "../../lib/supabase";
import {
    buildDocContext,
    buildMessages,
    buildUserPersonalisationPrompt,
    devLog,
    enrichWithPriorEvents,
    buildWorkflowStore,
    appendAskInputsResponseToAssistantMessage,
    generateSpotlightNonce,
    withoutEmptyAssistantReservations,
    type AskInputsResponseRequest,
    type ChatMessage,
} from "../../lib/chat";
import {
    getUserModelSettings,
    resolveUserChatSelection,
    persistLastSelectedChatModel,
    persistLastSelectedReasoningLevel,
} from "../user/user.service";
import {
    checkProjectAccess,
    ensureChatAccess,
    projectHasSharedAudience,
    resolveContentOrgId,
} from "../../lib/access";
import { loadProfileUsersByEmail } from "../../lib/userLookup";
import {
    deleteContentGrant,
    hasDirectContentGrants,
    listContentGrants,
    upsertContentGrant,
    type ContentAccessGrant,
} from "../../lib/contentAccess";
import { can, type ProjectRole } from "../../lib/permissions";
import {
    listContentPeople,
    type ResourcePeopleResult,
} from "../../lib/resourcePeople";
import { generateAssistantChatTitle } from "./chat.title";
import {
    resolveEffectiveChatModel,
    resolveEffectiveReasoningLevel,
    titleModelForChat,
} from "../../lib/modelSelection";
import {
    beginMemoryConversationTurn,
    releaseMemoryConversationTurn,
    type MemoryConversationTurn,
} from "../../lib/memory/schedule";

// One devLog for the whole tree lives in lib/chat; re-exported so the route
// file keeps importing it from the service alongside everything else.
export { devLog };
// Title generation is chat-domain logic (modules/chat/chat.title.ts);
// project-chat reaches it through this facade.
export { generateAssistantChatTitle };

export type AccessibleChat = {
    id: string;
    title: string | null;
    // Nullable since 20260902_01: content in an organization project outlives
    // the account that created it (the FK is ON DELETE SET NULL).
    user_id: string | null;
    project_id: string | null;
    model: string | null;
    reasoning_level: string | null;
    org_id?: string | null;
} & Record<string, unknown>;

export async function validateAccessibleProjectId(
    db: Db,
    args: {
        projectId: string | null;
        userId: string;
        userEmail: string | null | undefined;
    },
): Promise<{ ok: true } | { ok: false; status: number; detail: string }> {
    if (!args.projectId) return { ok: true };
    // Creating a chat under a project contributes content to it: member+.
    const access = await checkProjectAccess(
        args.projectId,
        args.userId,
        args.userEmail,
        db,
    );
    if (!access.ok || !can(access.projectRole, "content.edit"))
        return { ok: false, status: 404, detail: "Project not found" };
    return { ok: true };
}

export type ChatAccess =
    | {
          ok: true;
          chat: AccessibleChat;
          /** Provenance only ("I started this thread"), not a right — the
           *  admin role the creator branch derives is what grants. */
          isCreator: boolean;
          projectRole: ProjectRole;
      }
    | { ok: false };

// Resolve a chat AND the caller's role for it, so callers can gate reads and
// writes separately: "can you see it" (project.view) and "can you write to
// it" (content.edit) are different questions. The role comes from
// `ensureChatAccess` (lib/access.ts) — the same derivation reviews use: the
// project chats inherit the project role exactly. Standalone chats use
// role-aware direct grants.
export async function getAccessibleChat(
    db: Db,
    args: {
        chatId: string;
        userId: string;
        userEmail: string | null | undefined;
    },
): Promise<ChatAccess> {
    const { data: chat, error } = await db
        .from("chats")
        .select("*")
        .eq("id", args.chatId)
        .maybeSingle();
    if (error || !chat) return { ok: false };

    const row = chat as AccessibleChat;
    const access = await ensureChatAccess(row, args.userId, args.userEmail, db);
    if (!access.ok) return { ok: false };
    return {
        ok: true,
        chat: row,
        isCreator: access.isCreator,
        projectRole: access.projectRole,
    };
}

// Stored doc_edited events capture the `status` at the time the assistant
// produced the edit (always "pending"). If the user later accepts or rejects,
// `document_edits.status` is updated but the stored event is not. On chat load
// we merge the current DB status in so EditCards render with the real state.
async function hydrateEditStatuses(
    messages: Record<string, unknown>[],
    db: Db,
): Promise<Record<string, unknown>[]> {
    const editIds = new Set<string>();
    const versionIds = new Set<string>();
    const collectFromAnnList = (list: unknown) => {
        if (!Array.isArray(list)) return;
        for (const a of list as Record<string, unknown>[]) {
            if (typeof a?.edit_id === "string") editIds.add(a.edit_id);
            if (typeof a?.version_id === "string")
                versionIds.add(a.version_id);
        }
    };
    for (const m of messages) {
        const content = m.content;
        if (Array.isArray(content)) {
            for (const ev of content as Record<string, unknown>[]) {
                if (ev?.type === "doc_edited") {
                    collectFromAnnList(ev.annotations);
                    if (typeof ev.version_id === "string")
                        versionIds.add(ev.version_id);
                }
            }
        }
    }
    if (editIds.size === 0 && versionIds.size === 0) return messages;

    // Edit status patch.
    const statusById = new Map<string, "pending" | "accepted" | "rejected">();
    if (editIds.size > 0) {
        const { data: rows } = await db
            .from("document_edits")
            .select("id, status")
            .in("id", Array.from(editIds));
        for (const r of (rows ?? []) as { id: string; status: string }[]) {
            if (
                r.status === "pending" ||
                r.status === "accepted" ||
                r.status === "rejected"
            ) {
                statusById.set(r.id, r.status);
            }
        }
    }

    // Version-number patch — old stored events don't carry `version_number`
    // because they predate the schema change. Look it up from
    // document_versions so the UI can render "V3" chips + download filenames.
    const versionNumberById = new Map<string, number | null>();
    if (versionIds.size > 0) {
        const { data: vrows } = await db
            .from("document_versions")
            .select("id, version_number")
            .in("id", Array.from(versionIds));
        for (const r of (vrows ?? []) as {
            id: string;
            version_number: number | null;
        }[]) {
            versionNumberById.set(r.id, r.version_number ?? null);
        }
    }

    const patchAnnList = (list: unknown): unknown => {
        if (!Array.isArray(list)) return list;
        return (list as Record<string, unknown>[]).map((a) => {
            let next = a;
            if (typeof a?.edit_id === "string" && statusById.has(a.edit_id)) {
                next = { ...next, status: statusById.get(a.edit_id) };
            }
            if (
                typeof a?.version_id === "string" &&
                versionNumberById.has(a.version_id)
            ) {
                next = {
                    ...next,
                    version_number: versionNumberById.get(a.version_id) ?? null,
                };
            }
            return next;
        });
    };
    return messages.map((m) => {
        const next: Record<string, unknown> = { ...m };
        if (Array.isArray(m.content)) {
            next.content = (m.content as Record<string, unknown>[]).map(
                (ev) => {
                    if (ev?.type !== "doc_edited") return ev;
                    let patched: Record<string, unknown> = {
                        ...ev,
                        annotations: patchAnnList(ev.annotations),
                    };
                    if (
                        typeof ev.version_id === "string" &&
                        versionNumberById.has(ev.version_id)
                    ) {
                        patched = {
                            ...patched,
                            version_number:
                                versionNumberById.get(ev.version_id) ?? null,
                        };
                    }
                    return patched;
                },
            );
        }
        return next;
    });
}

// ---------------------------------------------------------------------------
// Non-streaming endpoints
// ---------------------------------------------------------------------------

// GET /chat
// Lists every chat the caller could open: the RPC's predicate mirrors
// ensureChatAccess branch for branch (creator, direct grant, accessible
// project), so the list and GET /chat/:chatId can never disagree
// about what exists. Each row carries is_owner so the sidebar can tell the
// caller's own chats from colleagues' ones — provenance, not a role.
export async function listChats(
    db: Db,
    args: {
        userId: string;
        userEmail: string | undefined;
        limit: number | null;
        offset: number;
    },
): Promise<{ ok: true; data: unknown[] } | { ok: false; error: unknown }> {
    const { data, error } = await db.rpc("get_chats_overview", {
        p_user_id: args.userId,
        p_user_email: args.userEmail?.trim().toLowerCase() ?? null,
        p_limit: args.limit,
        p_offset: args.offset,
    });
    if (error) return { ok: false, error };
    return { ok: true, data: data ?? [] };
}

// POST /chat/create
export async function createChat(
    db: Db,
    args: {
        userId: string;
        userEmail: string | undefined;
        projectId: string | null;
    },
): Promise<
    | { ok: true; id: string }
    | { ok: false; kind: "access"; status: number; detail: string }
    | { ok: false; kind: "error"; error: unknown }
> {
    const projectAccess = await validateAccessibleProjectId(db, {
        projectId: args.projectId,
        userId: args.userId,
        userEmail: args.userEmail,
    });
    if (!projectAccess.ok)
        return {
            ok: false,
            kind: "access",
            status: projectAccess.status,
            detail: projectAccess.detail,
        };

    // Tenant stamping, like every other content create: a project chat
    // inherits the project's org; a standalone chat is personal (org_id
    // null) and stays private until it receives a direct grant.
    const resolvedOrg = await resolveContentOrgId(db, {
        projectId: args.projectId,
    });
    if (!resolvedOrg.ok)
        return { ok: false, kind: "error", error: resolvedOrg.detail };
    const { data, error } = await db
        .from("chats")
        .insert({
            user_id: args.userId,
            project_id: args.projectId ?? null,
            org_id: resolvedOrg.orgId,
        })
        .select("id")
        .single();

    if (error) return { ok: false, kind: "error", error };
    return { ok: true, id: data.id };
}

// GET /chat/:chatId — the transcript, with the edit statuses hydrated and
// the never-populated assistant reservations dropped.
export async function getChatMessages(
    db: Db,
    chatId: string,
): Promise<Record<string, unknown>[]> {
    const { data: messages } = await db
        .from("chat_messages")
        .select("*")
        .eq("chat_id", chatId)
        .order("created_at", { ascending: true });

    return hydrateEditStatuses(
        withoutEmptyAssistantReservations(messages ?? []),
        db,
    );
}

// GET /chat/:chatId/people
export async function listChatPeople(
    db: Db,
    chat: AccessibleChat,
): Promise<ResourcePeopleResult> {
    return listContentPeople(db, "chat", chat);
}

// GET /chat/:chatId/access — role-aware direct grants.
export async function listChatGrants(
    db: Db,
    chatId: string,
): Promise<
    { ok: true; grants: ContentAccessGrant[] } | { ok: false; detail: string }
> {
    return listContentGrants(db, "chat", chatId);
}

// POST /chat/:chatId/access — grant or re-role one recipient.
export async function grantChatAccess(
    db: Db,
    args: {
        chatId: string;
        chat: AccessibleChat;
        userId: string;
        email: unknown;
        role: unknown;
    },
): Promise<
    | { ok: true; grant: ContentAccessGrant }
    | { ok: false; kind: "validation"; detail: string }
    | { ok: false; kind: "db_error"; detail: string }
> {
    const { userById } = await loadProfileUsersByEmail(db);
    return upsertContentGrant(db, {
        kind: "chat",
        resourceId: args.chatId,
        email: args.email,
        role: args.role,
        createdBy: args.userId,
        creatorEmail: args.chat.user_id
            ? userById.get(args.chat.user_id)?.email
            : null,
    });
}

// DELETE /chat/:chatId/access/:email — revoke one recipient.
export async function revokeChatAccess(
    db: Db,
    args: { chatId: string; email: string },
): Promise<{ ok: true; removed: boolean } | { ok: false; detail: string }> {
    return deleteContentGrant(db, {
        kind: "chat",
        resourceId: args.chatId,
        email: args.email,
    });
}

// PATCH /chat/:chatId — title and/or per-chat model + reasoning selection.
//
// The caller's role has already been checked by the route (title edits and
// model/reasoning changes are both content.edit). A model choice that
// resolves is also persisted as the user's last-selected chat model so their
// next new chat starts from it.
export async function updateChatSettings(
    db: Db,
    args: {
        chatId: string;
        userId: string;
        /** The chat's currently stored model, for model resolution. */
        chatModel: string | null;
        title?: string;
        requestedModel?: string | null;
        reasoningLevel?: ReturnType<typeof resolveEffectiveReasoningLevel>;
    },
): Promise<
    | { ok: true; data: Record<string, unknown> }
    | { ok: false; kind: "not_found" }
    | {
          ok: false;
          kind: "model";
          status: number;
          code: string;
          detail: string;
      }
    | { ok: false; kind: "error"; error: unknown }
> {
    const hasTitle = args.title !== undefined;
    const hasModel = "requestedModel" in args;

    const updates: Record<string, unknown> = {};
    if (hasTitle) updates.title = args.title;

    if (hasModel) {
        const settings = await getUserModelSettings(args.userId, db);
        const resolution = await resolveEffectiveChatModel({
            requested: args.requestedModel,
            chatModel: args.chatModel,
            lastSelectedModel: settings.last_selected_chat_model,
            apiKeys: settings.api_keys,
            userId: args.userId,
            db,
        });
        if (!resolution.ok) {
            return {
                ok: false,
                kind: "model",
                status: resolution.status,
                code: resolution.code,
                detail: resolution.detail,
            };
        }
        updates.model = resolution.model;
    }
    if (args.reasoningLevel) {
        updates.reasoning_level = args.reasoningLevel;
    }

    const { data, error } = await db
        .from("chats")
        .update(updates)
        .eq("id", args.chatId)
        .select("id, title, model, reasoning_level")
        .single();

    // Two different failures that must not share an answer. Authorization
    // already passed in the route, so a database error here is OUR fault, not
    // a statement about what exists: reporting it as "404 Chat not found"
    // tells the client a lie it will act on (dropping the chat from the
    // sidebar) and hides the outage from whoever is reading the logs. The row
    // being gone is the only real 404 — the chat was deleted between the
    // access check and the write. DELETE already splits them this way.
    if (error) return { ok: false, kind: "error", error };
    if (!data) return { ok: false, kind: "not_found" };

    if (typeof updates.model === "string") {
        const profileError = await persistLastSelectedChatModel(
            args.userId,
            updates.model,
            db,
        );
        if (profileError)
            return { ok: false, kind: "error", error: profileError };
    }
    if (args.reasoningLevel) {
        const profileError = await persistLastSelectedReasoningLevel(
            args.userId,
            args.reasoningLevel,
            db,
        );
        if (profileError)
            return { ok: false, kind: "error", error: profileError };
    }
    return { ok: true, data };
}

// DELETE /chat/:chatId
export async function deleteChat(
    db: Db,
    args: { chatId: string },
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    const { error } = await db.from("chats").delete().eq("id", args.chatId);

    if (error) return { ok: false, error };
    return { ok: true };
}

// Result of a write whose failure the caller decides how to treat: the
// streaming route rethrows it from inside the title promise (so the
// surrounding `.catch` logs it) but ignores it for the truncated-content
// fallback, which must never break a stream that already succeeded.
export type ChatWriteResult = { ok: true } | { ok: false; error: unknown };

// Persist a chat's title.
//
// Shared by `generateChatTitle` and by the two title-persistence points in
// the POST /chat stream (the generated title, and the fallback that
// truncates the user's message). It only reports the error; the SSE loop in
// the route keeps deciding whether to rethrow or ignore it.
export async function updateChatTitle(
    db: Db,
    args: { chatId: string; title: string },
): Promise<ChatWriteResult> {
    const { error } = await db
        .from("chats")
        .update({ title: args.title })
        .eq("id", args.chatId);

    if (error) return { ok: false, error };
    return { ok: true };
}

// POST /chat/:chatId/generate-title
export async function generateChatTitle(
    db: Db,
    args: {
        chatId: string;
        userId: string;
        /** The chat's currently stored model, for model resolution. */
        chatModel: string | null;
        message: string;
        requestedModel: string | null;
    },
): Promise<
    | { ok: true; title: string }
    | {
          ok: false;
          kind: "model";
          status: number;
          code: string;
          detail: string;
      }
    | { ok: false; kind: "error" }
> {
    try {
        const settings = await getUserModelSettings(args.userId, db);
        const resolution = await resolveEffectiveChatModel({
            requested: args.requestedModel,
            chatModel: args.chatModel,
            lastSelectedModel: settings.last_selected_chat_model,
            apiKeys: settings.api_keys,
            userId: args.userId,
            db,
        });
        if (!resolution.ok) {
            return {
                ok: false,
                kind: "model",
                status: resolution.status,
                code: resolution.code,
                detail: resolution.detail,
            };
        }
        const title = await generateAssistantChatTitle({
            model: titleModelForChat(resolution.model, settings.title_model),
            message: args.message,
            apiKeys: settings.api_keys,
        });

        await updateChatTitle(db, { chatId: args.chatId, title });

        return { ok: true, title };
    } catch (err) {
        console.error("[generate-title]", err);
        return { ok: false, kind: "error" };
    }
}

// ---------------------------------------------------------------------------
// Pre-stream preparation for POST /chat (streaming)
// ---------------------------------------------------------------------------
//
// This performs the DB work that precedes the SSE stream: resolving or creating
// the chat, persisting the user message, opening the memory conversation turn,
// building doc context + messages, and assembling the workflow store. It
// RETURNS the prepared data; the route owns the header flush, runLLMStream
// loop, and persistence.

export type PreparedChatStream = {
    chatId: string;
    chatTitle: string | null;
    lastUser: ChatMessage | undefined;
    resolvedProjectId: string | null;
    // Whether the turn that is about to stream has a durable row behind it.
    // An ask_inputs continuation that could not be appended is not durable,
    // and must not trigger memory consolidation.
    completedTurnPersisted: boolean;
    // Whether the document-writing tools are offered this turn. A standalone
    // chat writes into the caller's own library, so it keeps them; a project
    // chat writes into the PROJECT, and that is a question about the caller's
    // project role, never about their standing in the thread. See the long
    // note in modules/project-chat/projectChat.service.ts — this is the same
    // partition on the route that serves standalone and project chats alike.
    allowDocumentMutation: boolean;
    canReadProjectMemory: boolean;
    canCurateProjectMemory: boolean;
    memorySharedAudience: boolean;
    memoryTurn: MemoryConversationTurn | null;
    docIndex: Awaited<ReturnType<typeof buildDocContext>>["docIndex"];
    docStore: Awaited<ReturnType<typeof buildDocContext>>["docStore"];
    apiMessages: ReturnType<typeof buildMessages>;
    workflowStore: Awaited<ReturnType<typeof buildWorkflowStore>>;
    legalResearchUs: boolean;
    apiKeys: Awaited<ReturnType<typeof getUserModelSettings>>["api_keys"];
    titleModel: Awaited<
        ReturnType<typeof getUserModelSettings>
    >["title_model"];
    selectedModel: string;
    selectedReasoningLevel: ReturnType<
        typeof resolveEffectiveReasoningLevel
    >;
    nonce: ReturnType<typeof generateSpotlightNonce>;
};

export async function prepareChatStream(
    db: Db,
    args: {
        userId: string;
        userEmail: string | undefined;
        messages: ChatMessage[];
        chatId: string | null;
        // Pre-generated id for the user message this turn persists, so the
        // route can link the reserved assistant row back to it.
        inputMessageId: string | null;
        projectIdProvided: boolean;
        projectId: string | null;
        // Parsed `ask_inputs_response` payload (answers to an ask_inputs
        // event emitted by the assistant in a prior turn). When present, the
        // user's answers are appended onto the previous assistant message
        // instead of being stored as a new user message.
        askInputsResponse: AskInputsResponseRequest | null;
        requestedModel: string | null | undefined;
        requestedReasoning:
            | ReturnType<typeof resolveEffectiveReasoningLevel>
            | undefined;
    },
): Promise<
    | { ok: true; prepared: PreparedChatStream }
    | { ok: false; status: number; code?: string; detail: string }
    // "internal" carries the raw error so the route can hand it to
    // sendInternalError, preserving the request_id in the body and the
    // [http/internal-error] correlation log.
    | { ok: false; internal: true; error: unknown }
> {
    const { userId, userEmail, messages } = args;
    let chatId = args.chatId;
    let chatTitle: string | null = null;
    let chatModel: string | null = null;
    let chatReasoningLevel: string | null = null;
    let resolvedProjectId: string | null = args.projectId;
    let canReadProjectMemory = false;
    let canCurateProjectMemory = false;
    let memorySharedAudience = false;
    // Whether the document-writing tools are offered this turn. A standalone
    // chat writes into the caller's own library, so it keeps them; a project
    // chat writes into the PROJECT, and that is a question about the caller's
    // project role, never about their standing in the thread. See the long
    // note in modules/project-chat/projectChat.service.ts — this is the same
    // partition on the route that serves standalone and project chats alike.
    let allowDocumentMutation = true;

    if (chatId) {
        const access = await getAccessibleChat(db, {
            chatId,
            userId,
            userEmail,
        });
        if (!access.ok)
            return { ok: false, status: 404, detail: "Chat not found" };
        // Appending messages (and triggering LLM generation) writes to the
        // chat: member+ only, mirroring the new-chat path below. Viewers
        // can read this chat (GET) but must not be able to write into it.
        if (!can(access.projectRole, "content.edit"))
            return {
                ok: false,
                status: 403,
                detail: "You do not have permission to modify this chat",
            };
        const existing = access.chat;

        const existingProjectId = existing.project_id ?? null;
        if (
            args.projectIdProvided &&
            args.projectId !== existingProjectId
        ) {
            return {
                ok: false,
                status: 400,
                detail: "project_id does not match chat",
            };
        }
        resolvedProjectId = existingProjectId;
        memorySharedAudience =
            !!existing.org_id ||
            existing.user_id !== userId ||
            (await hasDirectContentGrants(db, "chat", existing.id));
        chatTitle = existing.title;
        chatModel = existing.model;
        chatReasoningLevel = existing.reasoning_level;
        if (existingProjectId) {
            // The role above may have come from the chat's own share list;
            // creating documents in the project needs the project's verdict.
            const projectAccess = await checkProjectAccess(
                existingProjectId,
                userId,
                userEmail,
                db,
            );
            canReadProjectMemory = projectAccess.ok;
            canCurateProjectMemory =
                projectAccess.ok &&
                can(projectAccess.projectRole, "content.edit");
            allowDocumentMutation = canCurateProjectMemory;
            if (projectAccess.ok) {
                memorySharedAudience =
                    memorySharedAudience ||
                    (await projectHasSharedAudience(
                        db,
                        existingProjectId,
                        projectAccess.project.org_id,
                    ));
            }
        }
    }

    const selection = await resolveUserChatSelection(db, {
        userId,
        chatModel,
        chatReasoningLevel,
        requestedModel: args.requestedModel,
        requestedReasoning: args.requestedReasoning,
    });
    if (!selection.ok) return selection;
    const { modelSettings, selectedModel, selectedReasoningLevel } = selection;

    if (
        chatId &&
        (chatModel !== selectedModel ||
            chatReasoningLevel !== selectedReasoningLevel)
    ) {
        const { error } = await db
            .from("chats")
            .update({
                model: selectedModel,
                reasoning_level: selectedReasoningLevel,
            })
            .eq("id", chatId);
        if (error) return { ok: false, internal: true, error };
    }

    if (!chatId) {
        // If creating a chat tied to a project, the user must have access
        // to the project (own or shared).
        const projectAccess = await validateAccessibleProjectId(db, {
            projectId: resolvedProjectId,
            userId,
            userEmail,
        });
        if (!projectAccess.ok)
            return {
                ok: false,
                status: projectAccess.status,
                detail: projectAccess.detail,
            };
        canReadProjectMemory = resolvedProjectId !== null;
        canCurateProjectMemory = resolvedProjectId !== null;

        const resolvedOrg = await resolveContentOrgId(db, {
            projectId: resolvedProjectId,
        });
        if (!resolvedOrg.ok)
            return { ok: false, internal: true, error: resolvedOrg.detail };
        memorySharedAudience = resolvedProjectId
            ? await projectHasSharedAudience(
                  db,
                  resolvedProjectId,
                  resolvedOrg.orgId,
              )
            : false;
        const { data: newChat, error } = await db
            .from("chats")
            .insert({
                user_id: userId,
                project_id: resolvedProjectId,
                model: selectedModel,
                reasoning_level: selectedReasoningLevel,
                org_id: resolvedOrg.orgId,
            })
            .select("id, title")
            .single();
        if (error || !newChat) {
            console.error("[chat/stream] failed to create chat", error);
            return { ok: false, status: 500, detail: "Failed to create chat" };
        }
        chatId = newChat.id as string;
        chatTitle = newChat.title;
    }

    if (!chatId) {
        return {
            ok: false,
            status: 500,
            detail: "Failed to initialize chat",
        };
    }

    devLog("[chat/stream] resolved chatId", chatId);

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    let completedTurnPersisted = true;
    let memoryTurn: MemoryConversationTurn | null = null;
    if (args.askInputsResponse) {
        const appendResult = await appendAskInputsResponseToAssistantMessage(
            db,
            chatId,
            args.askInputsResponse,
            userId,
        );
        if (appendResult === "forbidden") {
            return {
                ok: false,
                status: 403,
                detail:
                    "Only the user who started this turn can answer these questions",
            };
        }
        if (appendResult === "invalid") {
            return {
                ok: false,
                status: 400,
                detail: "The answers do not match the pending questions",
            };
        }
        if (appendResult === "stale") {
            return {
                ok: false,
                status: 409,
                code: "ask_inputs_stale",
                detail:
                    "These questions have already been answered or are no longer active",
            };
        }
        completedTurnPersisted = appendResult === "appended";
        if (!completedTurnPersisted) {
            return { ok: false, status: 500, detail: "Failed to save message" };
        }
    } else if (lastUser) {
        const { error: userMessageError } = await db
            .from("chat_messages")
            .insert({
                id: args.inputMessageId,
                chat_id: chatId,
                role: "user",
                content: lastUser.content,
                files: lastUser.files ?? null,
                workflow: lastUser.workflow ?? null,
                author_user_id: userId,
            });
        if (userMessageError) {
            return { ok: false, internal: true, error: userMessageError };
        }
    }

    if (args.askInputsResponse || lastUser) {
        try {
            memoryTurn = await beginMemoryConversationTurn({
                db,
                surface: "chat",
                conversationId: chatId,
                actorUserId: userId,
            });
        } catch (error) {
            return { ok: false, internal: true, error };
        }
    }

    // From here on a throw (document context, workflow store) would strand
    // the conversation turn opened above: the route's finally block only runs
    // once this function has returned it. Release on the way out instead.
    try {
        const { docIndex, docStore } = await buildDocContext(
            messages,
            userId,
            db,
            chatId,
        );
        const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
            doc_id,
            filename: info.filename,
        }));
        // Generate the nonce before enriching prior events so document filenames
        // and workflow titles replayed from earlier turns are fenced as well.
        const nonce = generateSpotlightNonce();
        const enrichedMessages = await enrichWithPriorEvents(
            messages,
            chatId,
            db,
            docIndex,
            nonce,
        );
        const {
            api_keys: apiKeys,
            legal_research_us: legalResearchUs,
            title_model: titleModel,
            personalisation,
        } = modelSettings;
        const personalisationPrompt = buildUserPersonalisationPrompt(
            personalisation,
            nonce,
        );
        const apiMessages = buildMessages(
            enrichedMessages,
            docAvailability,
            personalisationPrompt || undefined,
            undefined,
            legalResearchUs,
            nonce,
        );

        const workflowStore = await buildWorkflowStore(userId, userEmail, db);

        return {
            ok: true,
            prepared: {
                chatId,
                chatTitle,
                lastUser,
                resolvedProjectId,
                completedTurnPersisted,
                allowDocumentMutation,
                canReadProjectMemory,
                canCurateProjectMemory,
                memorySharedAudience,
                memoryTurn,
                docIndex,
                docStore,
                apiMessages,
                workflowStore,
                legalResearchUs,
                apiKeys,
                titleModel,
                selectedModel,
                selectedReasoningLevel,
                nonce,
            },
        };
    } catch (error) {
        if (memoryTurn) {
            try {
                await releaseMemoryConversationTurn({
                    db,
                    surface: "chat",
                    conversationId: chatId,
                    turn: memoryTurn,
                });
            } catch {
                console.warn("[memory] chat activity release failed", {
                    chatId,
                });
            }
        }
        throw error;
    }
}
