/**
 * How the task pane tells the user something failed.
 *
 * `describeError` (shared with the web app) decides *what* to say; this
 * module decides *how* the add-in says it: a toast with an honest "Retry"
 * and, for failures the user cannot fix themselves, a "Contact support"
 * link that opens a pre-filled email carrying the request id.
 *
 * Mirrors frontend/src/app/lib/userFacingError.ts so a failure reads the
 * same in Word as it does in the browser. Screens must never render a raw
 * `error.message` from the API, a stream, or Office.js.
 */
import {
  buildSupportMailto,
  describeError,
  type DescribeErrorOptions,
  type UserFacingError,
} from "@mike/user-error";
import { showToast, type ToastAction } from "@mike/toast-ui";

export {
  SUPPORT_EMAIL,
  UserVisibleError,
  buildSupportMailto,
  describeError,
  isAbortError,
  isNetworkError,
  type UserErrorKind,
  type UserFacingError,
} from "@mike/user-error";

/** Which client the support email came from. */
export const SUPPORT_PRODUCT = "word-addin";

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
  /** Short screen name, e.g. "Workflows". Falls back to the pane URL. */
  page?: string;
}

/** The pre-filled support email for a failure seen in the task pane. */
export function supportMailtoFor(
  error: Pick<
    UserFacingError,
    "title" | "message" | "kind" | "status" | "code" | "requestId"
  >,
  options: { note?: string; page?: string } = {},
): string {
  return buildSupportMailto(error, {
    page:
      options.page ??
      (typeof window !== "undefined" ? window.location.href : undefined),
    product: SUPPORT_PRODUCT,
    note: options.note,
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

  // warn, not error: Sentry's console bridge forwards console.error, and a
  // 4xx or a cancellation the user just saw is not an incident. Real faults
  // were already reported where they were caught (5xx, transport).
  if (process.env.NODE_ENV !== "production") {
    console.warn("[user-error]", described.title, described.cause);
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
      ? supportMailtoFor(described, {
          note: options.supportNote,
          page: options.page,
        })
      : undefined,
    dedupeKey: options.dedupeKey,
  });

  return described;
}

/**
 * One deduped toast when the backend says the session is gone and a refresh
 * could not bring it back. No "Retry": there is nothing to retry until the
 * user signs in again.
 */
export function notifySessionExpired(): void {
  showToast({
    tone: "error",
    title: "Sign in required",
    message: "Your session has expired. Sign in again to continue.",
    dedupeKey: "session-expired",
  });
}

export function notifySuccess(message: string, title?: string): string {
  return showToast({ tone: "success", title, message });
}

export function notifyInfo(message: string, title?: string): string {
  return showToast({ tone: "info", title, message });
}

/**
 * The user-facing sentence for a failure, with nothing shown on screen.
 * Use where a screen already has a place to put an inline message.
 */
export function userMessage(
  error: unknown,
  options: DescribeErrorOptions = {},
): string {
  return describeError(error, options).message;
}
