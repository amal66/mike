/**
 * The Word add-in has no test runner of its own; its pure error-reporting
 * functions are exercised here through the same `@mike/*` aliases webpack
 * resolves, so a change to either side of the contract fails one suite.
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";
import { describeError } from "@/shared/lib/userError";
import {
    MikeApiError,
    parseApiErrorBody,
} from "../../../word-addin/src/taskpane/api/client";
import {
    NetworkUnreachableError,
    networkErrorMessage,
    networkFailure,
    requestOrigin,
} from "../../../word-addin/src/taskpane/lib/networkError";
import {
    notifyError,
    notifySessionExpired,
    userMessage,
} from "../../../word-addin/src/taskpane/lib/notify";

describe("parseApiErrorBody", () => {
    it("keeps the backend's 4xx detail, code and request id", () => {
        expect(
            parseApiErrorBody({
                status: 400,
                body: JSON.stringify({
                    code: "password_too_long",
                    detail: "Password must be at most 72 characters.",
                    request_id: "req-1",
                }),
            }),
        ).toEqual({
            message: "Password must be at most 72 characters.",
            code: "password_too_long",
            requestId: "req-1",
        });
    });

    it("never echoes a 5xx body, JSON or not", () => {
        for (const body of [
            JSON.stringify({ detail: "relation user_profiles does not exist" }),
            "<html>502 Bad Gateway</html>",
        ]) {
            const parsed = parseApiErrorBody({ status: 502, body, requestId: "h" });
            expect(parsed.message).toBe("Something went wrong on our side. Try again.");
            expect(parsed.requestId).toBe("h");
        }
    });

    it("falls back to a bare status marker that describeError replaces", () => {
        const parsed = parseApiErrorBody({ status: 404, body: "not json" });
        expect(parsed.message).toBe("API error: 404");
        const described = describeError(
            new MikeApiError({ status: 404, message: parsed.message }),
        );
        expect(described.kind).toBe("not_found");
        expect(described.message).not.toContain("API error");
    });

    it("reads the nested error envelope some routes use", () => {
        expect(
            parseApiErrorBody({
                status: 409,
                body: JSON.stringify({
                    error: { code: "review_running", message: "Already running.", request_id: "r" },
                }),
            }),
        ).toEqual({ message: "Already running.", code: "review_running", requestId: "r" });
    });
});

describe("network failures", () => {
    it("names the origin and classifies as a retryable network error", () => {
        const error = networkFailure(new TypeError("Load failed"), {
            method: "POST",
            url: "http://localhost:3001/api/auth/login",
        });
        expect(error).toBeInstanceOf(NetworkUnreachableError);
        expect(error.message).toBe(
            "Mike couldn't reach the server at http://localhost:3001. Check your connection and that the server is running.",
        );
        const described = describeError(error, { action: "sign in" });
        expect(described.kind).toBe("network");
        expect(described.retryable).toBe(true);
        expect(described.supportable).toBe(false);
        expect(described.message).toContain("http://localhost:3001");
        expect(described.message).not.toContain("Load failed");
        expect(described.title).toBe("Couldn't sign in");
    });

    it("resolves relative URLs against the pane", () => {
        expect(requestOrigin("/api/x")).toBe(window.location.origin);
        expect(networkErrorMessage("https://api.example.test/v1")).toContain(
            "https://api.example.test",
        );
    });
});

describe("add-in notify", () => {
    beforeEach(() => {
        clearToasts();
        vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
        clearToasts();
        vi.restoreAllMocks();
    });

    it("shows Retry and a word-addin support email for a server failure", () => {
        render(<ToastViewportUI />);
        const onRetry = vi.fn();
        act(() => {
            notifyError(
                new MikeApiError({ status: 500, message: "x", requestId: "req-7" }),
                { action: "apply the edit", onRetry, page: "Chat" },
            );
        });
        const alert = screen.getByRole("alert");
        expect(alert).toHaveTextContent("Couldn't apply the edit");
        expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
        const href = decodeURIComponent(
            screen.getByRole("link", { name: "Contact support" }).getAttribute("href") ?? "",
        );
        expect(href.startsWith("mailto:will@mikeoss.com?")).toBe(true);
        expect(href).toContain("Client: word-addin");
        expect(href).toContain("Page: Chat");
        expect(href).toContain("Request ID: req-7");
    });

    it("stays silent on cancellation and dedupes the session-expired notice", () => {
        render(<ToastViewportUI />);
        act(() => {
            expect(notifyError(new DOMException("x", "AbortError"))).toBeNull();
            notifySessionExpired();
            notifySessionExpired();
        });
        expect(screen.getAllByRole("alert")).toHaveLength(1);
        expect(screen.getByRole("alert")).toHaveTextContent("session has expired");
        expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });

    it("userMessage returns the sentence without showing anything", () => {
        render(<ToastViewportUI />);
        expect(
            userMessage(new MikeApiError({ status: 429, message: "API error: 429" })),
        ).toMatch(/Too many requests/);
        expect(screen.queryByRole("alert")).toBeNull();
    });
});
