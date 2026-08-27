import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarChatItem } from "./SidebarChatItem";
import type { Chat } from "@/app/components/shared/types";

// The live round left this surface as the one place still gating on
// `chat.user_id === user.id` with failures swallowed. These tests pin the
// ladder rules the rest of the stack enforces: rename is member-tier
// (content.edit), delete is admin-tier (container.delete), and a failed
// delete is told to the user instead of silently reappearing on reload.

const renameChat = vi.fn();
const deleteChat = vi.fn();

vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({ renameChat, deleteChat }),
}));

function chat(overrides: Partial<Chat>): Chat {
    return {
        id: "chat-1",
        title: "Quarterly filing",
        user_id: "someone-else",
        created_at: new Date().toISOString(),
        ...overrides,
    } as Chat;
}

function openMenu() {
    // The kebab trigger is the only unnamed button; the row label button
    // carries the chat title. Radix opens on pointerdown, not click.
    const buttons = screen.getAllByRole("button");
    const trigger = buttons.find((b) => !b.textContent?.trim())!;
    fireEvent.pointerDown(
        trigger,
        new MouseEvent("pointerdown", { bubbles: true, cancelable: true }),
    );
    fireEvent.click(trigger);
}

beforeEach(() => {
    vi.clearAllMocks();
    deleteChat.mockResolvedValue(undefined);
});

describe("SidebarChatItem role gates", () => {
    it("lets a shared member rename but not delete", async () => {
        render(
            <SidebarChatItem
                chat={chat({ is_owner: false, access_role: "member" })}
                isActive
                onSelect={vi.fn()}
            />,
        );
        openMenu();
        fireEvent.click(await screen.findByText("Delete"));

        expect(deleteChat).not.toHaveBeenCalled();
        expect(
            await screen.findByText(/only an admin/i),
        ).toBeInTheDocument();
    });

    it("lets the creator delete — is_owner alone derives admin", async () => {
        render(
            <SidebarChatItem
                chat={chat({ is_owner: true })}
                isActive
                onSelect={vi.fn()}
            />,
        );
        openMenu();
        fireEvent.click(await screen.findByText("Delete"));

        expect(deleteChat).toHaveBeenCalledWith("chat-1");
    });

    it("refuses a viewer's rename with the member tier", async () => {
        render(
            <SidebarChatItem
                chat={chat({ is_owner: false, access_role: "viewer" })}
                isActive
                onSelect={vi.fn()}
            />,
        );
        openMenu();
        fireEvent.click(await screen.findByText("Rename"));

        expect(
            await screen.findByText(/only a member/i),
        ).toBeInTheDocument();
    });

    it("surfaces a failed delete instead of swallowing it", async () => {
        deleteChat.mockRejectedValue(new Error("boom"));
        render(
            <SidebarChatItem
                chat={chat({ is_owner: true })}
                isActive
                onSelect={vi.fn()}
            />,
        );
        openMenu();
        fireEvent.click(await screen.findByText("Delete"));

        expect(
            await screen.findByText(/could not be deleted/i),
        ).toBeInTheDocument();
    });
});
