import { createServerSupabase } from "./supabase";
import { deleteFile, extractedTextKey, listFiles } from "./storage";
import { enqueueStorageCleanup } from "./dbq/enqueue";
import { removeGrantsForEmail } from "./projectAccess";

type Db = ReturnType<typeof createServerSupabase>;

const DELETE_BATCH_SIZE = 500;

function uniqueStrings(values: Array<string | null | undefined>): string[] {
    return [...new Set(values.filter((value): value is string => !!value))];
}

function chunks<T>(values: T[], size = DELETE_BATCH_SIZE): T[][] {
    const result: T[][] = [];
    for (let i = 0; i < values.length; i += size) {
        result.push(values.slice(i, i + size));
    }
    return result;
}

async function throwIfError<T extends { message?: string } | null>(
    error: T,
    context: string,
) {
    if (error) throw new Error(`${context}: ${error.message ?? "unknown error"}`);
}

async function deleteByIds(db: Db, table: string, ids: string[]) {
    for (const batch of chunks(ids)) {
        const { error } = await (db as any).from(table).delete().in("id", batch);
        await throwIfError(error, `Failed to delete ${table}`);
    }
}

async function deleteWhereIn(
    db: Db,
    table: string,
    column: string,
    values: string[],
) {
    for (const batch of chunks(values)) {
        const { error } = await (db as any)
            .from(table)
            .delete()
            .in(column, batch);
        await throwIfError(error, `Failed to delete ${table}`);
    }
}

/**
 * Split the projects a user created into the personal ones (destroyed on
 * account deletion) and the organization ones (kept, and detached).
 */
async function partitionOwnedProjects(
    db: Db,
    userId: string,
): Promise<{ personal: string[]; org: string[] }> {
    const { data, error } = await db
        .from("projects")
        .select("id, org_id")
        .eq("user_id", userId);
    await throwIfError(error, "Failed to load user projects");
    const rows = (data ?? []) as { id: string | null; org_id?: string | null }[];
    return {
        personal: uniqueStrings(
            rows.filter((row) => !row.org_id).map((row) => row.id),
        ),
        org: uniqueStrings(rows.filter((row) => !!row.org_id).map((row) => row.id)),
    };
}

/**
 * Documents that must go when this account is erased: the ones they uploaded
 * plus everything sitting in a personal project of theirs — MINUS anything
 * living in an organization project, which stays with the organization.
 */
async function getDocumentIdsForAccountDeletion(
    db: Db,
    userId: string,
    personalProjectIds: string[],
    orgProjectIds: string[],
): Promise<string[]> {
    const [ownedDocs, projectDocs, orgProjectDocs] = await Promise.all([
        db.from("documents").select("id").eq("user_id", userId),
        personalProjectIds.length > 0
            ? db
                  .from("documents")
                  .select("id")
                  .in("project_id", personalProjectIds)
            : Promise.resolve({ data: [], error: null }),
        orgProjectIds.length > 0
            ? db.from("documents").select("id").in("project_id", orgProjectIds)
            : Promise.resolve({ data: [], error: null }),
    ]);

    await throwIfError(ownedDocs.error, "Failed to load user documents");
    await throwIfError(projectDocs.error, "Failed to load project documents");
    await throwIfError(
        orgProjectDocs.error,
        "Failed to load organization project documents",
    );

    const keep = new Set(
        uniqueStrings(
            ((orgProjectDocs.data ?? []) as { id: string | null }[]).map(
                (row) => row.id,
            ),
        ),
    );
    return uniqueStrings([
        ...((ownedDocs.data ?? []) as { id: string | null }[]).map(
            (row) => row.id,
        ),
        ...((projectDocs.data ?? []) as { id: string | null }[]).map(
            (row) => row.id,
        ),
    ]).filter((id) => !keep.has(id));
}

/**
 * Re-anchor the content the departing user left inside organization projects.
 * Their rows survive with `user_id = NULL` — the content belongs to the
 * organization, and its FKs are ON DELETE SET NULL so the auth.users cascade
 * that follows this cleanup will not take them.
 */
async function detachOrgProjectContent(
    db: Db,
    userId: string,
    orgProjectIds: string[],
) {
    if (orgProjectIds.length === 0) return;
    const tables = [
        "documents",
        "chats",
        "tabular_reviews",
        "project_subfolders",
    ] as const;
    for (const table of tables) {
        for (const batch of chunks(orgProjectIds)) {
            const { error } = await (db as any)
                .from(table)
                .update({ user_id: null })
                .eq("user_id", userId)
                .in("project_id", batch);
            await throwIfError(error, `Failed to detach ${table}`);
        }
    }
    for (const batch of chunks(orgProjectIds)) {
        const { error } = await db
            .from("projects")
            .update({ user_id: null })
            .in("id", batch);
        await throwIfError(error, "Failed to detach organization projects");
    }
}

async function collectDocumentVersionPaths(
    db: Db,
    documentIds: string[],
): Promise<string[]> {
    const paths = new Set<string>();

    for (const batch of chunks(documentIds)) {
        const { data, error } = await db
            .from("document_versions")
            .select("id, storage_path, pdf_storage_path")
            .in("document_id", batch);
        await throwIfError(error, "Failed to load document storage paths");

        for (const version of data ?? []) {
            // The extracted-text cache is keyed by version id and lives
            // outside the per-user storage prefixes, so nothing else would
            // ever enumerate it. Deleting an object that was never written is
            // a no-op, so this is unconditional rather than type-gated.
            if (typeof version.id === "string" && version.id.length > 0) {
                paths.add(extractedTextKey(version.id));
            }
            if (
                typeof version.storage_path === "string" &&
                version.storage_path.length > 0
            ) {
                paths.add(version.storage_path);
            }
            if (
                typeof version.pdf_storage_path === "string" &&
                version.pdf_storage_path.length > 0
            ) {
                paths.add(version.pdf_storage_path);
            }
        }
    }

    return [...paths];
}

async function deleteDocumentVersionFiles(db: Db, documentIds: string[]) {
    const paths = await collectDocumentVersionPaths(db, documentIds);
    await Promise.all(paths.map((path) => deleteFile(path)));
}

async function deleteUserStoragePrefix(userId: string) {
    try {
        const paths = new Set([
            ...(await listFiles(`documents/${userId}/`)),
            ...(await listFiles(`workflow-references/${userId}/`)),
        ]);
        await Promise.all(
            [...paths].map((path) => deleteFile(path).catch(() => {})),
        );
    } catch {
        // Version-linked objects are deleted above. Prefix cleanup is best-effort
        // for orphaned files left behind by interrupted uploads.
    }
}

/**
 * Purge the account's export artifacts (`exports/<userId>/…`). Each object
 * here is a complete copy of the account's data, and once account deletion
 * purges the user's db_jobs rows this listing is the last enumeration of
 * those objects anywhere. So unlike the orphan sweep above, failures MUST
 * propagate: the caller is a durable job (or the route's inline fallback,
 * which surfaces a 5xx) and a retry re-runs this with the listing intact.
 * Swallowing here would let erasure report success while a full export of
 * the user's data survives with nothing left pointing at it.
 */
async function deleteUserExportArtifacts(userId: string) {
    let paths: string[];
    try {
        paths = await listFiles(`exports/${userId}/`);
    } catch (err) {
        throw new Error(
            `Failed to list export artifacts: ${
                err instanceof Error ? err.message : "unknown error"
            }`,
        );
    }
    let failures = 0;
    for (const path of paths) {
        try {
            await deleteFile(path);
        } catch {
            failures += 1;
        }
    }
    if (failures > 0) {
        throw new Error(
            `Failed to delete ${failures}/${paths.length} export artifacts`,
        );
    }
}

async function removeEmailFromSharedWith(
    db: Db,
    table: "projects" | "tabular_reviews",
    email: string | null | undefined,
) {
    const normalizedEmail = email?.trim().toLowerCase();
    if (!normalizedEmail) return;

    const { data, error } = await db
        .from(table)
        .select("id, shared_with")
        .filter("shared_with", "cs", JSON.stringify([normalizedEmail]));
    await throwIfError(error, `Failed to load shared ${table}`);

    const updates = (data ?? [])
        .map((row) => {
            const sharedWith = Array.isArray(row.shared_with)
                ? row.shared_with.filter(
                      (value) =>
                          typeof value !== "string" ||
                          value.trim().toLowerCase() !== normalizedEmail,
                  )
                : [];
            return { id: row.id as string, sharedWith };
        })
        .filter((row) => row.id);

    await Promise.all(
        updates.map(async ({ id, sharedWith }) => {
            const { error: updateError } = await db
                .from(table)
                .update({ shared_with: sharedWith })
                .eq("id", id);
            await throwIfError(updateError, `Failed to update shared ${table}`);
        }),
    );
}

/**
 * Tear down a user's organization footprint on account deletion.
 *
 * An organization is a durable owner in its own right, not an extension of
 * whoever happened to create it, so this NEVER deletes an org that still has
 * people or content in it:
 *
 *  - The departing user's membership row is removed.
 *  - If they were the org's sole admin, the earliest remaining member is
 *    promoted so the org is never stranded without anyone able to administer
 *    it. The promotion happens BEFORE the removal, both to avoid a window
 *    where the org has no admin and because the
 *    org_members_protect_last_admin trigger would otherwise reject the
 *    delete outright.
 *  - An org left with no members at all is deleted only when it also holds no
 *    projects. An org whose last member leaves but whose matters live on is
 *    kept: deleting it would take the firm's content with it, which is
 *    exactly the outcome this model exists to prevent.
 *  - Any invitations the user sent lose their inviter reference through the
 *    FK's ON DELETE SET NULL; invitations addressed TO them are cancelled.
 */
export async function deleteUserOrganizations(
    db: Db,
    userId: string,
    userEmail?: string | null,
) {
    const { data: memberships, error: membershipError } = await db
        .from("org_members")
        .select("id, org_id, role")
        .eq("user_id", userId);
    await throwIfError(membershipError, "Failed to load org memberships");

    for (const m of (memberships ?? []) as {
        id: string;
        org_id: string;
        role: string;
    }[]) {
        if (m.role === "admin") {
            const { data: otherAdmins } = await db
                .from("org_members")
                .select("id")
                .eq("org_id", m.org_id)
                .eq("role", "admin")
                .neq("id", m.id);
            if (((otherAdmins ?? []) as unknown[]).length === 0) {
                const { data: remaining } = await db
                    .from("org_members")
                    .select("id")
                    .eq("org_id", m.org_id)
                    .neq("id", m.id)
                    .order("created_at", { ascending: true })
                    .limit(1);
                const heir = ((remaining ?? []) as { id: string }[])[0];
                if (heir) {
                    const { error: promoteError } = await db
                        .from("org_members")
                        .update({ role: "admin" })
                        .eq("id", heir.id);
                    await throwIfError(
                        promoteError,
                        "Failed to hand off org administration",
                    );
                } else {
                    const { data: orgProjects } = await db
                        .from("projects")
                        .select("id")
                        .eq("org_id", m.org_id)
                        .limit(1);
                    if (((orgProjects ?? []) as unknown[]).length === 0) {
                        await deleteByIds(db, "organizations", [m.org_id]);
                        continue; // cascade removed the membership row
                    }
                }
            }
        }

        const { error: deleteError } = await db
            .from("org_members")
            .delete()
            .eq("id", m.id);
        await throwIfError(deleteError, "Failed to remove org membership");
    }

    const normalizedEmail = userEmail?.trim().toLowerCase();
    if (normalizedEmail) {
        const { error: inviteError } = await db
            .from("org_invitations")
            .update({
                status: "cancelled",
                cancelled_at: new Date().toISOString(),
            })
            .eq("email", normalizedEmail)
            .eq("status", "pending");
        await throwIfError(inviteError, "Failed to cancel org invitations");
    }
}

export async function deleteAllUserChats(db: Db, userId: string) {
    const [assistantChats, tabularChats, wordDocuments] = await Promise.all([
        db.from("chats").delete().eq("user_id", userId),
        db.from("tabular_review_chats").delete().eq("user_id", userId),
        db.from("word_documents").delete().eq("user_id", userId),
    ]);

    await throwIfError(assistantChats.error, "Failed to delete assistant chats");
    await throwIfError(tabularChats.error, "Failed to delete tabular chats");
    await throwIfError(wordDocuments.error, "Failed to delete Word chats");
}

export async function deleteAllUserTabularReviews(db: Db, userId: string) {
    const { data: reviews, error: reviewsError } = await db
        .from("tabular_reviews")
        .select("id")
        .eq("user_id", userId);
    await throwIfError(reviewsError, "Failed to load tabular reviews");

    const reviewIds = uniqueStrings(
        ((reviews ?? []) as { id: string | null }[]).map((row) => row.id),
    );
    if (reviewIds.length === 0) return 0;

    const { data: reviewChats, error: reviewChatsError } = await db
        .from("tabular_review_chats")
        .select("id")
        .in("review_id", reviewIds);
    await throwIfError(reviewChatsError, "Failed to load tabular review chats");

    const reviewChatIds = uniqueStrings(
        ((reviewChats ?? []) as { id: string | null }[]).map((row) => row.id),
    );

    await deleteWhereIn(
        db,
        "tabular_review_chat_messages",
        "chat_id",
        reviewChatIds,
    );
    await deleteWhereIn(db, "tabular_review_chats", "review_id", reviewIds);
    await deleteWhereIn(db, "tabular_cells", "review_id", reviewIds);
    await deleteByIds(db, "tabular_reviews", reviewIds);

    return reviewIds.length;
}

/**
 * Delete projects (and everything inside them) by id, with no ownership
 * filter. Callers must have authorised the delete themselves — routes do that
 * through the `container.delete` capability, and an organization project may
 * have no creator left to scope by anyway.
 */
export async function deleteProjectsByIds(db: Db, projectIds: string[]) {
    const ownedProjectIds = uniqueStrings(projectIds);
    if (ownedProjectIds.length === 0) return 0;

    const [projectDocs, projectChats, projectReviews, projectFolders] =
        await Promise.all([
            db.from("documents").select("id").in("project_id", ownedProjectIds),
            db.from("chats").select("id").in("project_id", ownedProjectIds),
            db
                .from("tabular_reviews")
                .select("id")
                .in("project_id", ownedProjectIds),
            db
                .from("project_subfolders")
                .select("id")
                .in("project_id", ownedProjectIds),
        ]);

    await throwIfError(projectDocs.error, "Failed to load project documents");
    await throwIfError(projectChats.error, "Failed to load project chats");
    await throwIfError(
        projectReviews.error,
        "Failed to load project tabular reviews",
    );
    await throwIfError(projectFolders.error, "Failed to load project folders");

    const documentIds = uniqueStrings(
        ((projectDocs.data ?? []) as { id: string | null }[]).map(
            (row) => row.id,
        ),
    );
    const chatIds = uniqueStrings(
        ((projectChats.data ?? []) as { id: string | null }[]).map(
            (row) => row.id,
        ),
    );
    const reviewIds = uniqueStrings(
        ((projectReviews.data ?? []) as { id: string | null }[]).map(
            (row) => row.id,
        ),
    );
    const folderIds = uniqueStrings(
        ((projectFolders.data ?? []) as { id: string | null }[]).map(
            (row) => row.id,
        ),
    );

    const { data: reviewChats, error: reviewChatsError } =
        reviewIds.length > 0
            ? await db
                  .from("tabular_review_chats")
                  .select("id")
                  .in("review_id", reviewIds)
            : { data: [], error: null };
    await throwIfError(reviewChatsError, "Failed to load project review chats");

    const reviewChatIds = uniqueStrings(
        ((reviewChats ?? []) as { id: string | null }[]).map((row) => row.id),
    );

    // Collect the storage keys BEFORE the version rows go away, but delete
    // the files AFTER the rows via the durable storage.cleanup job: if any
    // row delete below fails, no file has been touched; if the process dies
    // after them, the queued job still removes the files (the old inline
    // Promise.all died with the request and leaked on any storage error).
    const storagePaths = await collectDocumentVersionPaths(db, documentIds);
    await deleteWhereIn(
        db,
        "tabular_review_chat_messages",
        "chat_id",
        reviewChatIds,
    );
    await deleteWhereIn(db, "tabular_review_chats", "review_id", reviewIds);
    await deleteWhereIn(db, "tabular_cells", "review_id", reviewIds);
    await deleteByIds(db, "tabular_reviews", reviewIds);
    await deleteWhereIn(db, "chat_messages", "chat_id", chatIds);
    await deleteByIds(db, "chats", chatIds);
    await deleteByIds(db, "documents", documentIds);
    await deleteByIds(db, "project_subfolders", folderIds);
    await deleteByIds(db, "projects", ownedProjectIds);

    await enqueueStorageCleanup(db, storagePaths);

    return ownedProjectIds.length;
}

/**
 * Remove the projects a user created — but only the personal ones.
 *
 * A project that belongs to an organization is the organization's, not the
 * creator's: the firm's other admins are still administering it and its
 * matter documents are still live. Those projects are DETACHED instead
 * (user_id → NULL, which the nullable FK now permits) so they survive their
 * creator's departure with their contents intact. Only `org_id IS NULL`
 * projects — the genuinely personal ones — are destroyed.
 *
 * The return value counts destroyed projects, so a caller deleting a single
 * org project sees 0 and can report "nothing was removed" accurately.
 */
export async function deleteUserProjects(
    db: Db,
    userId: string,
    projectIds?: string[],
) {
    const requestedProjectIds = projectIds
        ? uniqueStrings(projectIds)
        : undefined;
    if (requestedProjectIds && requestedProjectIds.length === 0) return 0;

    let query = db.from("projects").select("id, org_id").eq("user_id", userId);
    if (requestedProjectIds) query = query.in("id", requestedProjectIds);

    const { data: projects, error: projectsError } = await query;
    await throwIfError(projectsError, "Failed to load user projects");

    const rows = (projects ?? []) as {
        id: string | null;
        org_id?: string | null;
    }[];
    const personalProjectIds = uniqueStrings(
        rows.filter((row) => !row.org_id).map((row) => row.id),
    );
    const orgProjectIds = uniqueStrings(
        rows.filter((row) => !!row.org_id).map((row) => row.id),
    );

    if (orgProjectIds.length > 0) {
        for (const batch of chunks(orgProjectIds)) {
            const { error } = await db
                .from("projects")
                .update({ user_id: null })
                .in("id", batch);
            await throwIfError(error, "Failed to detach organization projects");
        }
    }

    return deleteProjectsByIds(db, personalProjectIds);
}

export async function deleteUserAccountData(
    db: Db,
    userId: string,
    userEmail?: string | null,
) {
    const { personal: personalProjectIds, org: orgProjectIds } =
        await partitionOwnedProjects(db, userId);
    const documentIds = await getDocumentIdsForAccountDeletion(
        db,
        userId,
        personalProjectIds,
        orgProjectIds,
    );

    await Promise.all([
        // Direct project access is a grant row now, so revoking this person's
        // access means deleting their grants (which also refreshes the
        // shared_with mirror on each affected project).
        removeGrantsForEmail(db, userEmail),
        removeEmailFromSharedWith(db, "tabular_reviews", userEmail),
        deleteDocumentVersionFiles(db, documentIds),
        deleteUserStoragePrefix(userId),
        deleteUserExportArtifacts(userId),
    ]);

    // Hand the organization's projects (and the content inside them) over to
    // the organization BEFORE the by-user deletions below run, so those
    // deletions no longer match the rows we are keeping.
    await detachOrgProjectContent(db, userId, orgProjectIds);

    await deleteByIds(db, "documents", documentIds);

    const deletions = [
        db.from("tabular_review_chats").delete().eq("user_id", userId),
        db.from("tabular_reviews").delete().eq("user_id", userId),
        db.from("chats").delete().eq("user_id", userId),
        db.from("word_documents").delete().eq("user_id", userId),
        db.from("project_subfolders").delete().eq("user_id", userId),
        db.from("hidden_workflows").delete().eq("user_id", userId),
        db
            .from("workflow_open_source_submissions")
            .delete()
            .eq("submitted_by_user_id", userId),
        db.from("workflow_shares").delete().eq("shared_by_user_id", userId),
        userEmail
            ? db
                  .from("workflow_shares")
                  .delete()
                  .eq("shared_with_email", userEmail.trim().toLowerCase())
            : Promise.resolve({ error: null }),
        // Audit rows carry the user's id, email, chat/document titles and prompt
        // excerpts, so account erasure must remove them as well.
        db.from("audit_events").delete().eq("user_id", userId),
        db.from("projects").delete().eq("user_id", userId),
        db.from("quick_actions").delete().eq("user_id", userId),
        db
            .from("default_workflow_installations")
            .delete()
            .eq("user_id", userId),
    ];

    const results = await Promise.all(deletions);
    for (const result of results) {
        await throwIfError(result.error, "Failed to delete account data");
    }

    const { error: workflowsError } = await db
        .from("workflows")
        .delete()
        .eq("user_id", userId);
    await throwIfError(workflowsError, "Failed to delete workflows");

    // Organizations use ON DELETE SET NULL on content (not CASCADE), so the
    // content deletions above never touch the user's org memberships — settle
    // those (and hand off administration where needed) here.
    await deleteUserOrganizations(db, userId, userEmail);
}
