import type { Db } from "../../lib/supabase";
import { enqueueStorageCleanup } from "../../lib/dbq/enqueue";
import {
  ok,
  internalFailure,
  type ServiceResult,
} from "../../lib/serviceResult";

type CollectionScope =
  | { kind: "project"; projectId: string }
  | { kind: "library"; userId: string; libraryKind: "file" | "template" };

/**
 * Delete a collection's documents, then enqueue source/rendition cleanup.
 * Project callers must first authorize docs.organize and select ids from that
 * project. Library callers pass the actor's userId; eligibility is rechecked
 * here because bulk-delete accepts arbitrary requested ids. The same scope is
 * applied again to the DELETE. This preserves the existing collection policy;
 * single-document/version deletion has a separate extracted-text-cache policy.
 */
export async function deleteCollectionDocuments(
  db: Db,
  scope: CollectionScope,
  documentIds: string[],
): Promise<ServiceResult<{ deletedIds: string[] }>> {
  if (!documentIds.length) return ok({ deletedIds: [] });
  let eligibleIds = documentIds;
  if (scope.kind === "library") {
    let query = db
      .from("documents")
      .select("id")
      .eq("user_id", scope.userId)
      .is("project_id", null);
    query =
      scope.libraryKind === "file"
        ? query.or("library_kind.eq.file,library_kind.is.null")
        : query.eq("library_kind", scope.libraryKind);
    const { data, error } = await query.in("id", documentIds);
    if (error) return internalFailure(error);
    eligibleIds = (data ?? []).map((doc) => doc.id as string);
    if (!eligibleIds.length) return ok({ deletedIds: [] });
  }
  const { data: versions, error: versionsError } = await db
    .from("document_versions")
    .select("storage_path, pdf_storage_path")
    .in("document_id", eligibleIds);
  if (versionsError) return internalFailure(versionsError);
  const paths = new Set<string>();
  for (const version of versions ?? []) {
    for (const path of [version.storage_path, version.pdf_storage_path]) {
      if (typeof path === "string" && path.length > 0) paths.add(path);
    }
  }
  let query = db.from("documents").delete();
  if (scope.kind === "project") query = query.eq("project_id", scope.projectId);
  else {
    query = query.eq("user_id", scope.userId).is("project_id", null);
    query =
      scope.libraryKind === "file"
        ? query.or("library_kind.eq.file,library_kind.is.null")
        : query.eq("library_kind", scope.libraryKind);
  }
  const { error } = await query.in("id", eligibleIds);
  if (error) return internalFailure(error);
  await enqueueStorageCleanup(db, [...paths]);
  return ok({ deletedIds: eligibleIds });
}
