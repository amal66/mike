"use client";

import { useEffect } from "react";
import { PillButtonUI } from "@/shared/ui/PillButtonUI";
import { reportError } from "@/app/lib/errorReporting";
import { buildSupportMailto, describeError } from "@/shared/lib/userError";

export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset?: () => void;
}) {
    useEffect(() => {
        // The root layout itself failed: nothing else can report this one.
        reportError(error, {
            level: "fatal",
            tags: { component: "global-error-boundary", digest: error.digest },
        });
        console.error("Global error:", error);
    }, [error]);

    // The whole document failed to render, so the only thing safe to show is
    // the digest; the raw message stays in the console and the support email.
    const described = describeError(error, { action: "load this page" });
    const supportHref = buildSupportMailto(described, {
        page: typeof window !== "undefined" ? window.location.href : undefined,
        product: "web",
        note: `Error reference: ${error.digest ?? "unavailable"}`,
    });

    return (
        <html lang="en">
            <head>
                <title>Something went wrong – Mike</title>
                <style>{`
                    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=EB+Garamond:wght@400;500&display=swap');
                    
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    
                    body {
                        font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
                        background-color: #ffffff;
                        color: #111;
                        min-height: 100vh;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                    }

                    .error-container {
                        text-align: center;
                        max-width: 480px;
                        padding: 2rem;
                    }

                    .error-title {
                        font-family: 'EB Garamond', Georgia, serif;
                        font-size: 1.75rem;
                        font-weight: 400;
                        color: #111;
                        margin-bottom: 0.75rem;
                    }

                    .error-message {
                        font-size: 0.9375rem;
                        color: #6b7280;
                        line-height: 1.6;
                        margin-bottom: 2rem;
                    }

                    .btn-back { font-family: 'Inter', sans-serif; }

                    .error-actions {
                        display: flex;
                        flex-wrap: wrap;
                        gap: 0.75rem;
                        justify-content: center;
                    }

                    .error-support {
                        margin-top: 1.5rem;
                        font-size: 0.875rem;
                        color: #6b7280;
                    }

                    .error-support a { color: inherit; font-weight: 500; }

                    .error-reference { margin-left: 0.5rem; color: #9ca3af; }
                `}</style>
            </head>
            <body>
                <div className="error-container">
                    <h1 className="error-title">Something went wrong</h1>
                    <p className="error-message">
                        Mike couldn&apos;t load this page. Try again, and
                        contact support if it keeps happening.
                    </p>
                    <div className="error-actions">
                        {reset && (
                            <PillButtonUI
                                type="button"
                                tone="blue"
                                size="normal"
                                className="btn-back"
                                onClick={() => reset()}
                            >
                                Try again
                            </PillButtonUI>
                        )}
                        <PillButtonUI
                            type="button"
                            tone="white"
                            size="normal"
                            className="btn-back"
                            onClick={() => window.history.back()}
                        >
                            Back
                        </PillButtonUI>
                    </div>
                    <p className="error-support">
                        <a href={supportHref}>Contact support</a>
                        {error.digest && (
                            <span className="error-reference">
                                Error reference: {error.digest}
                            </span>
                        )}
                    </p>
                </div>
            </body>
        </html>
    );
}
