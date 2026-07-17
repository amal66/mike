// Streaming prepare guard for the tabular-review generate stream.
//
// STREAMING: the SSE endpoint (POST /:reviewId/generate) keeps its streaming
// loop, abort handling, and per-token persistence in the route. Only the
// NON-streaming work lives here — the pre-stream "prepare" guard (access
// checks, document loading, missing-API-key checks) that returns the data the
// route then streams over.

import { attachActiveVersionPaths } from "../documentVersions";
import { type UserApiKeys } from "../llm";
import { getUserModelSettings } from "../userSettings";
import {
    ensureReviewAccess,
    filterAccessibleDocumentIds,
} from "../access";
import {
    missingModelApiKey,
    type Column,
    type Db,
    type MissingApiKey,
} from "./tabular.shared";

// ---------------------------------------------------------------------------
// Streaming prepare guards (non-streaming work before the SSE loop)
// ---------------------------------------------------------------------------

export type PreparedGenerate = {
    columns: Column[];
    cellMap: Map<string, Record<string, unknown>>;
    docs: Record<string, unknown>[];
    tabular_model: string;
    api_keys: UserApiKeys;
};

export async function prepareTabularGenerate(
    db: Db,
    args: { reviewId: string; userId: string; userEmail: string | undefined },
): Promise<
    | { ok: true; data: PreparedGenerate }
    | { ok: false; kind: "not_found" }
    | { ok: false; kind: "no_columns" }
    | { ok: false; kind: "missing_api_key"; missingKey: MissingApiKey }
> {
    const { reviewId, userId, userEmail } = args;

    const { data: review, error: reviewError } = await db
        .from("tabular_reviews")
        .select("*")
        .eq("id", reviewId)
        .single();
    if (reviewError || !review) return { ok: false, kind: "not_found" };
    const access = await ensureReviewAccess(review, userId, userEmail, db);
    if (!access.ok) return { ok: false, kind: "not_found" };

    const columns: Column[] = review.columns_config ?? [];
    if (columns.length === 0) return { ok: false, kind: "no_columns" };

    const { data: cells } = await db
        .from("tabular_cells")
        .select("*")
        .eq("review_id", reviewId);
    const cellMap = new Map<string, Record<string, unknown>>();
    for (const cell of cells ?? [])
        cellMap.set(`${cell.document_id}:${cell.column_index}`, cell);

    const docIds = [
        ...new Set((cells ?? []).map((c: any) => c.document_id)),
    ] as string[];
    const allowedDocIds = new Set(
        await filterAccessibleDocumentIds(docIds, userId, userEmail, db),
    );
    let docs: Record<string, unknown>[] = [];
    if (docIds.length > 0) {
        const filteredIds = docIds.filter((id: string) =>
            allowedDocIds.has(id),
        );
        const { data } =
            filteredIds.length > 0
                ? await db
                      .from("documents")
                      .select("id, current_version_id")
                      .in("id", filteredIds)
                : { data: [] as Record<string, unknown>[] };
        docs = data ?? [];
    } else if (review.project_id) {
        const { data } = await db
            .from("documents")
            .select("id, current_version_id")
            .eq("project_id", review.project_id)
            .order("created_at", { ascending: true });
        docs = data ?? [];
    }
    await attachActiveVersionPaths(
        db,
        docs as {
            id: string;
            current_version_id?: string | null;
        }[],
    );

    const { tabular_model, api_keys } = await getUserModelSettings(userId, db);
    const missingKey = missingModelApiKey(tabular_model, api_keys);
    if (missingKey) return { ok: false, kind: "missing_api_key", missingKey };

    return {
        ok: true,
        data: { columns, cellMap, docs, tabular_model, api_keys },
    };
}
