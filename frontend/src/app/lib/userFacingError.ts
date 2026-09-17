import { MikeApiError } from "./mikeApi";

export function userFacingApiError(
    error: unknown,
    fallback: string,
): string {
    if (
        error instanceof MikeApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.message
    ) {
        return error.message;
    }
    return fallback;
}

export function errorCode(error: unknown): string | null {
    if (!error || typeof error !== "object" || !("code" in error)) {
        return null;
    }
    return typeof error.code === "string" ? error.code : null;
}

export function knownErrorCodeMessage(
    error: unknown,
    messages: Readonly<Record<string, string>>,
    fallback: string,
): string {
    const code = errorCode(error);
    return code ? messages[code] ?? fallback : fallback;
}

// ---------------------------------------------------------------------------
// Notification layer
// ---------------------------------------------------------------------------
//
// `describeError` (shared) decides what to say; this file decides how the
// web app shows it: a toast with an honest "Retry" and, for failures the
// user cannot fix, a "Contact support" link that opens a pre-filled email.

import {
    buildSupportMailto,
    describeError,
    type DescribeErrorOptions,
    type UserFacingError,
} from "@/shared/lib/userError";
import { showToast, type ToastAction } from "@/shared/ui/ToastUI";

export {
    SUPPORT_EMAIL,
    UserVisibleError,
    describeError,
    isAbortError,
    isNetworkError,
    type UserErrorKind,
    type UserFacingError,
} from "@/shared/lib/userError";

export interface NotifyErrorOptions extends DescribeErrorOptions {
    /** Re-run the failed action. Offered only when a retry is honest. */
    onRetry?: () => void | Promise<void>;
    /** Collapse repeats (polling loops, autosave) into one toast. */
    dedupeKey?: string;
    /** Force the support link on or off regardless of classification. */
    support?: boolean;
    /** Extra actions beyond Retry. */
    actions?: ToastAction[];
    /** Extra text for the support email body, e.g. which document. */
    supportNote?: string;
}

/** The pre-filled support email for a described failure on this page. */
export function supportMailtoFor(
    error: UserFacingError,
    note?: string,
): string {
    return buildSupportMailto(error, {
        page: typeof window !== "undefined" ? window.location.href : undefined,
        product: "web",
        note,
    });
}

/**
 * Show a failure to the user. Returns the description so the caller can
 * also render it inline, or `null` when the failure is a cancellation the
 * user caused and does not need to hear about.
 */
export function notifyError(
    error: unknown,
    options: NotifyErrorOptions = {},
): UserFacingError | null {
    const described = describeError(error, options);
    if (described.kind === "aborted") return null;

    if (process.env.NODE_ENV !== "production") {
        console.error("[user-error]", described.title, described.cause);
    }

    const actions: ToastAction[] = [...(options.actions ?? [])];
    if (options.onRetry && described.retryable) {
        actions.push({ label: "Retry", onClick: options.onRetry });
    }
    const wantsSupport = options.support ?? described.supportable;

    showToast({
        tone: "error",
        title: described.title,
        message: described.message,
        actions,
        supportHref: wantsSupport
            ? supportMailtoFor(described, options.supportNote)
            : undefined,
        dedupeKey: options.dedupeKey,
    });

    return described;
}

export function notifySuccess(message: string, title?: string): string {
    return showToast({ tone: "success", title, message });
}

export function notifyInfo(message: string, title?: string): string {
    return showToast({ tone: "info", title, message });
}
