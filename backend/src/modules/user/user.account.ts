// Account / data deletion (destructive — exact call args + ordering preserved).
//
// Service layer behind user.routes.ts — see user.shared.ts for the module's
// contract. The userDataCleanup helpers + auth-admin deleteUser call are
// invoked with identical args and ordering.

import { enqueueDbJob } from "../../lib/dbq/enqueue";
import {
    deleteAllUserChats,
    deleteAllUserTabularReviews,
    deleteUserAccountData,
    deleteUserProjects,
} from "../../lib/userDataCleanup";
import { type Db, errorMessage } from "./user.shared";

export async function deleteUserAccount(
    db: Db,
    userId: string,
    userEmail: string | undefined,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
        // Order matters, and is the REVERSE of the old inline flow:
        // 1. Delete the auth user first. From the user's point of view
        //    the account is now gone (no login, sessions revoked) and if
        //    THIS fails, nothing has happened — the request is cleanly
        //    retriable.
        // 2. Then enqueue the data cascade as a durable job. The old
        //    inline cascade died with the request or a restart, leaving
        //    a half-deleted account with no owner; the job retries until
        //    the (idempotent) cascade completes.
        const { error } = await db.auth.admin.deleteUser(userId);
        if (error) return { ok: false, error };
        try {
            await enqueueDbJob(db, {
                kind: "account.delete",
                payload: { userId, userEmail: userEmail ?? null },
                dedupeKey: `account.delete:${userId}`,
                maxAttempts: 20,
            });
        } catch (enqueueErr) {
            // Auth user is already gone — the user cannot retry. Fall
            // back to the old inline cascade rather than stranding the
            // data.
            console.error(
                "[user/account] cleanup enqueue failed; running inline",
                { userId, error: errorMessage(enqueueErr) },
            );
            await deleteUserAccountData(db, userId, userEmail);
        }
        return { ok: true };
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/account] delete failed", {
            userId,
            error: detail,
        });
        return { ok: false, error: err };
    }
}

export async function deleteUserChats(
    db: Db,
    userId: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
        await deleteAllUserChats(db, userId);
        return { ok: true };
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/chats] delete failed", {
            userId,
            error: detail,
        });
        return { ok: false, error: err };
    }
}

export async function deleteUserProjectsData(
    db: Db,
    userId: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
        await deleteUserProjects(db, userId);
        return { ok: true };
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/projects] delete failed", {
            userId,
            error: detail,
        });
        return { ok: false, error: err };
    }
}

export async function deleteUserTabularReviews(
    db: Db,
    userId: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
        await deleteAllUserTabularReviews(db, userId);
        return { ok: true };
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/tabular-reviews] delete failed", {
            userId,
            error: detail,
        });
        return { ok: false, error: err };
    }
}
