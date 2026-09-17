import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiKeyField } from "./ApiKeyField";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";

const { needsMfaVerification } = vi.hoisted(() => ({
    needsMfaVerification: vi.fn(),
}));

vi.mock("@/app/components/popups/MfaVerificationPopup", () => ({
    needsMfaVerification,
    MfaVerificationPopup: () => null,
}));

vi.mock("@/app/lib/mikeApi", () => ({
    isMfaRequiredError: () => false,
}));

function renderField(overrides: {
    onSave?: () => Promise<boolean>;
    onRemove?: () => Promise<boolean>;
    hasSavedKey?: boolean;
}) {
    render(
        <>
            <ApiKeyField
                label="Anthropic API key"
                placeholder="sk-..."
                hasSavedKey={overrides.hasSavedKey ?? false}
                onSave={overrides.onSave ?? (async () => true)}
                onRemove={overrides.onRemove ?? (async () => true)}
            />
            <ToastViewportUI />
        </>,
    );
}

describe("ApiKeyField", () => {
    beforeEach(() => {
        clearToasts();
        needsMfaVerification.mockReset();
        needsMfaVerification.mockResolvedValue(false);
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        clearToasts();
    });

    it("reports a refused save in a toast with a retry, not an alert", async () => {
        const alertSpy = vi.fn();
        vi.stubGlobal("alert", alertSpy);
        const onSave = vi
            .fn<() => Promise<boolean>>()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        const user = userEvent.setup();
        renderField({ onSave });

        await user.type(screen.getByLabelText("Anthropic API key"), "sk-test");
        await user.click(screen.getByRole("button", { name: "Save" }));

        const toast = await screen.findByRole("alert");
        expect(toast).toHaveTextContent("Couldn't save your Anthropic API key");
        expect(toast).toHaveTextContent(
            "Mike couldn't save your Anthropic API key. The key was not changed.",
        );
        expect(alertSpy).not.toHaveBeenCalled();

        await user.click(
            await screen.findByRole("button", { name: "Retry" }),
        );
        expect(onSave).toHaveBeenCalledTimes(2);

        vi.unstubAllGlobals();
    });

    it("explains a network failure instead of echoing it", async () => {
        const onSave = vi
            .fn<() => Promise<boolean>>()
            .mockRejectedValue(new TypeError("Failed to fetch"));
        const user = userEvent.setup();
        renderField({ onSave });

        await user.type(screen.getByLabelText("Anthropic API key"), "sk-test");
        await user.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Mike couldn't reach the server. Check your connection and try again.",
        );
    });

    it("reports a refused removal and leaves the key in place", async () => {
        const onRemove = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
        const user = userEvent.setup();
        renderField({ onRemove, hasSavedKey: true });

        await user.click(screen.getByRole("button", { name: "Remove" }));

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Mike couldn't remove your Anthropic API key. The key is still saved.",
        );
    });
});
