import * as Sentry from "@sentry/node";
import type { Express } from "express";

// Sentry is fully optional. With SENTRY_DSN unset (the default), every export
// here is a no-op: init does nothing, captureException drops the error, and the
// Express error handler is never registered. This keeps the default deployment
// free of any external error-reporting dependency or network traffic.

let initialized = false;

/** SENTRY_TRACES_SAMPLE_RATE clamped to 0..1, defaulting to 0 (errors only). */
function tracesSampleRate(): number {
    const raw = Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0");
    if (!Number.isFinite(raw)) return 0;
    return Math.min(1, Math.max(0, raw));
}

/**
 * Initialize the Sentry Node SDK — but only when SENTRY_DSN is set. Must run at
 * the very top of the process, before any instrumented module (Express, http,
 * etc.) is imported, because Sentry's auto-instrumentation patches modules at
 * load time. Safe to call exactly once at boot; subsequent calls are ignored.
 */
export function initSentry(): void {
    if (initialized) return;

    // Air-gapped: never send errors out (they can carry document snippets).
    if (process.env.AIRGAPPED === "true") {
        console.log("Sentry disabled (AIRGAPPED)");
        return;
    }

    if (!process.env.SENTRY_DSN) {
        console.log("Sentry disabled (SENTRY_DSN not set)");
        return;
    }

    const environment =
        process.env.SENTRY_ENVIRONMENT ??
        process.env.NODE_ENV ??
        "development";
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment,
        tracesSampleRate: tracesSampleRate(),
    });
    initialized = true;
    console.log("Sentry error monitoring initialized", { environment });
}

/**
 * Forward an error to Sentry when monitoring is enabled; otherwise a no-op.
 * Used by the process-level crash handlers so fatal errors are captured before
 * the process exits, in addition to the existing console logs.
 */
export function captureException(
    err: unknown,
    context?: Record<string, unknown>,
): void {
    if (!initialized) return;
    Sentry.captureException(err, context ? { extra: context } : undefined);
}

/**
 * Register Sentry's Express error handler. In @sentry/node v8 this is
 * `Sentry.setupExpressErrorHandler`, which must be registered after all routes
 * but before any other error-handling middleware so Sentry sees the error
 * first, then delegates to the app's own error handling. No-op when Sentry is
 * disabled.
 */
export function setupSentryErrorHandler(app: Express): void {
    if (!initialized) return;
    Sentry.setupExpressErrorHandler(app);
}
