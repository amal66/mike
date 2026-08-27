import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The sidebar's role gates read each row through roleFrom(), which fails
// closed to viewer when a row carries neither is_owner nor access_role. The
// rows the overview RPC serves always carry both — but the OPTIMISTIC row
// saveChat prepends is built by hand, and a bare row locked the creator out
// of renaming and deleting their own brand-new thread until a reload.

const { createChat, listChats } = vi.hoisted(() => ({
    createChat: vi.fn(),
    listChats: vi.fn(),
}));

vi.mock("@/app/lib/mikeApi", () => ({
    createChat: (...args: unknown[]) => createChat(...args),
    listChats: (...args: unknown[]) => listChats(...args),
    renameChat: vi.fn(async () => undefined),
    deleteChat: vi.fn(async () => undefined),
}));
// One stable user object: the provider reloads the chat list whenever the
// user identity changes, and a fresh object per render would wipe the
// optimistic row this test exists to observe.
const STABLE_USER = { id: "u1", email: "a@firm.test" };
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: STABLE_USER }),
}));

import {
    ChatHistoryProvider,
    useChatHistoryContext,
} from "./ChatHistoryContext";
import { roleFrom } from "@/app/lib/permissions";

function Probe() {
    const { chats, saveChat } = useChatHistoryContext();
    const optimistic = chats?.find((c) => c.id === "chat-9");
    return (
        <div>
            <button onClick={() => void saveChat()}>save</button>
            <span data-testid="loaded">{String(chats !== null)}</span>
            <span data-testid="role">
                {optimistic ? roleFrom(optimistic) : "absent"}
            </span>
            <span data-testid="is-owner">
                {String(optimistic?.is_owner ?? "absent")}
            </span>
        </div>
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    createChat.mockResolvedValue({ id: "chat-9" });
    listChats.mockResolvedValue([]);
});

describe("saveChat's optimistic row", () => {
    it("carries the creator's admin standing, as the server would serve it", async () => {
        render(
            <ChatHistoryProvider>
                <Probe />
            </ChatHistoryProvider>,
        );
        await waitFor(() =>
            expect(screen.getByTestId("loaded")).toHaveTextContent("true"),
        );

        fireEvent.click(screen.getByText("save"));

        // What the gates actually consume is the derived role: a bare row
        // resolves to viewer, and the creator is refused their own thread.
        await waitFor(() =>
            expect(screen.getByTestId("role")).toHaveTextContent("admin"),
        );
        expect(screen.getByTestId("is-owner")).toHaveTextContent("true");
    });
});
