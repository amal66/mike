import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";
import { MikeApiError } from "./mikeApi";
import {
    errorCode,
    knownErrorCodeMessage,
    notifyError,
    notifyInfo,
    notifySuccess,
    supportMailtoFor,
    userFacingApiError,
} from "./userFacingError";

describe("userFacingApiError", () => {
    it("allows intentional client-error details", () => {
        const error = new MikeApiError({
            status: 400,
            message: "The filename is required.",
        });

        expect(userFacingApiError(error, "Fallback")).toBe(
            "The filename is required.",
        );
    });

    it("does not expose server or plain exception messages", () => {
        expect(
            userFacingApiError(
                new MikeApiError({
                    status: 500,
                    message: "relation user_profiles does not exist",
                }),
                "Please try again.",
            ),
        ).toBe("Please try again.");
        expect(
            userFacingApiError(
                new Error("getaddrinfo ENOTFOUND internal-db"),
                "Please try again.",
            ),
        ).toBe("Please try again.");
    });

    it("rejects non-client statuses and empty client-error messages", () => {
        expect(
            userFacingApiError(
                new MikeApiError({ status: 399, message: "Unexpected" }),
                "Fallback",
            ),
        ).toBe("Fallback");
        expect(
            userFacingApiError(
                new MikeApiError({ status: 400, message: "" }),
                "Fallback",
            ),
        ).toBe("Fallback");
    });
});

describe("errorCode", () => {
    it("returns null for values without a string code", () => {
        expect(errorCode(null)).toBeNull();
        expect(errorCode("invalid_credentials")).toBeNull();
        expect(errorCode({})).toBeNull();
        expect(errorCode({ code: 403 })).toBeNull();
    });
});

describe("knownErrorCodeMessage", () => {
    it("maps allowlisted codes and hides unknown ones", () => {
        const messages = { invalid_credentials: "Incorrect credentials." };
        expect(
            knownErrorCodeMessage(
                { code: "invalid_credentials" },
                messages,
                "Unable to log in.",
            ),
        ).toBe("Incorrect credentials.");
        expect(
            knownErrorCodeMessage(
                { code: "internal_provider_error" },
                messages,
                "Unable to log in.",
            ),
        ).toBe("Unable to log in.");
    });

    it("uses the fallback when no error code is available", () => {
        expect(
            knownErrorCodeMessage(
                new Error("provider failed"),
                { invalid_credentials: "Incorrect credentials." },
                "Unable to log in.",
            ),
        ).toBe("Unable to log in.");
    });
});

describe("notifyError", () => {
    beforeEach(() => {
        clearToasts();
        vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
        clearToasts();
        vi.restoreAllMocks();
    });

    it("shows a toast with Retry and Contact support for a server failure", () => {
        render(<ToastViewportUI />);
        const onRetry = vi.fn();
        const result: { described: ReturnType<typeof notifyError> } = {
            described: null,
        };
        act(() => {
            result.described = notifyError(
                new MikeApiError({
                    status: 500,
                    message: "internal",
                    requestId: "req-9",
                }),
                { action: "save the document", onRetry },
            );
        });
        expect(result.described?.kind).toBe("server");
        const alert = screen.getByRole("alert");
        expect(alert).toHaveTextContent("Couldn't save the document");
        expect(alert).not.toHaveTextContent("internal");
        expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
        const support = screen.getByRole("link", { name: "Contact support" });
        expect(support.getAttribute("href")).toMatch(
            /^mailto:will@mikeoss\.com\?/,
        );
        expect(decodeURIComponent(support.getAttribute("href") ?? "")).toContain(
            "Request ID: req-9",
        );
    });

    it("offers neither Retry nor support for a validation failure", () => {
        render(<ToastViewportUI />);
        act(() => {
            notifyError(
                new MikeApiError({
                    status: 400,
                    message: "Password must be at most 72 characters.",
                }),
                { onRetry: () => {} },
            );
        });
        expect(screen.getByRole("alert")).toHaveTextContent(
            "Password must be at most 72 characters.",
        );
        expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
        expect(
            screen.queryByRole("link", { name: "Contact support" }),
        ).toBeNull();
    });

    it("stays silent for a cancellation", () => {
        render(<ToastViewportUI />);
        const result: { described: ReturnType<typeof notifyError> } = {
            described: undefined as unknown as null,
        };
        act(() => {
            result.described = notifyError(
                new DOMException("aborted", "AbortError"),
            );
        });
        expect(result.described).toBeNull();
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("collapses repeated failures sharing a dedupe key", () => {
        render(<ToastViewportUI />);
        act(() => {
            notifyError(new TypeError("Failed to fetch"), { dedupeKey: "poll" });
            notifyError(new TypeError("Failed to fetch"), { dedupeKey: "poll" });
        });
        expect(screen.getAllByRole("alert")).toHaveLength(1);
    });

    it("notifySuccess shows a status toast", () => {
        render(<ToastViewportUI />);
        act(() => {
            notifySuccess("Saved");
        });
        expect(screen.getByRole("status")).toHaveTextContent("Saved");
    });
});

describe("notifyError options", () => {
    beforeEach(() => {
        clearToasts();
        vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
        clearToasts();
        vi.restoreAllMocks();
    });

    it("honours support overrides and extra actions", () => {
        render(<ToastViewportUI />);
        const onOpen = vi.fn();
        act(() => {
            notifyError(new MikeApiError({ status: 500, message: "x" }), {
                support: false,
                actions: [{ label: "Open settings", onClick: onOpen }],
            });
            notifyError(
                new MikeApiError({ status: 400, message: "Bad input." }),
                { support: true, supportNote: "While renaming Contract.docx" },
            );
        });
        expect(
            screen.getByRole("button", { name: "Open settings" }),
        ).toBeVisible();
        const links = screen.getAllByRole("link", { name: "Contact support" });
        expect(links).toHaveLength(1);
        expect(decodeURIComponent(links[0].getAttribute("href") ?? "")).toContain(
            "Details: While renaming Contract.docx",
        );
    });

    it("notifyInfo shows a status toast with a title", () => {
        render(<ToastViewportUI />);
        act(() => {
            notifyInfo("Export started", "Heads up");
        });
        expect(screen.getByRole("status")).toHaveTextContent("Heads up");
        expect(screen.getByRole("status")).toHaveTextContent("Export started");
    });

    it("supportMailtoFor works without a window", () => {
        const win = globalThis.window;
        // @ts-expect-error simulate a non-browser runtime
        delete globalThis.window;
        try {
            const href = supportMailtoFor({
                kind: "server",
                title: "T",
                message: "M",
                retryable: true,
                supportable: true,
                status: 500,
                code: null,
                requestId: null,
                cause: null,
            });
            expect(href).not.toContain("Page:");
            expect(href).toContain("Client");
        } finally {
            globalThis.window = win;
        }
    });
});
