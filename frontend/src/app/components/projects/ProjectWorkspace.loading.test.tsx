import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getProject } from "@/app/lib/mikeApi";
import type { Project } from "@/app/components/shared/types";
import {
    ProjectWorkspaceProvider,
    useProjectWorkspace,
} from "./ProjectWorkspace";

// The shell's chrome and its heavy modals are out of scope: this file pins
// WHAT THE ROLE IS while the project row is in flight, and what the gated
// entry points do in that window.
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
    useSelectedLayoutSegments: () => [],
}));
vi.mock("@/app/lib/mikeApi", () => ({
    createTabularReview: vi.fn(),
    deleteProject: vi.fn(),
    getProject: vi.fn(),
    getProjectAccess: vi.fn(async () => ({ grants: [] })),
    getProjectPeople: vi.fn(),
    grantProjectAccess: vi.fn(),
    listProjectChats: vi.fn(async () => []),
    revokeProjectAccess: vi.fn(),
    updateProject: vi.fn(),
}));
vi.mock("@/app/components/tabular/NewTRModal", () => ({
    NewTRModal: ({ open }: { open: boolean }) =>
        open ? <div>new review modal</div> : null,
}));
vi.mock("@/app/components/modals/PeopleModal", () => ({
    PeopleModal: () => null,
}));
vi.mock("./ProjectDetailsModal", () => ({ ProjectDetailsModal: () => null }));
vi.mock("@/app/contexts/ChatHistoryContext", () => ({
    useChatHistoryContext: () => ({ saveChat: vi.fn(async () => "chat-1") }),
}));
vi.mock("@/app/contexts/AuthContext", () => ({
    useAuth: () => ({ user: { id: "u1", email: "a@firm.test" } }),
}));
vi.mock("@/app/contexts/UserProfileContext", () => ({
    useUserProfile: () => ({ profile: { displayName: "A" } }),
}));

// A stub header exposing the three role-gated entry points as plain buttons,
// so the test drives the same callbacks the real header wires up.
vi.mock("./ProjectPageParts", () => ({
    ProjectPageHeader: ({
        roleKnown,
        onDeleteProject,
        onNewReview,
    }: {
        roleKnown?: boolean;
        onDeleteProject: () => void;
        onNewReview: () => void;
    }) => (
        <div>
            <span data-testid="role-known">{String(roleKnown)}</span>
            <button onClick={onDeleteProject}>delete project</button>
            <button onClick={onNewReview}>new review</button>
        </div>
    ),
}));

function Probe() {
    const { accessRole, canDo } = useProjectWorkspace();
    return (
        <div>
            <span data-testid="role">{String(accessRole)}</span>
            <span data-testid="can-delete">
                {String(canDo("container.delete"))}
            </span>
            <span data-testid="can-edit">{String(canDo("content.edit"))}</span>
        </div>
    );
}

function renderWorkspace() {
    return render(
        <ProjectWorkspaceProvider projectId="p1">
            <Probe />
        </ProjectWorkspaceProvider>,
    );
}

const ADMIN_PROJECT = {
    id: "p1",
    name: "Matter",
    access_role: "admin",
    documents: [],
    folders: [],
} as unknown as Project;

describe("ProjectWorkspace while the project is still loading", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("reports an unknown role instead of assuming admin", async () => {
        // The regression: `project ? roleFrom(project) : "admin"` handed the
        // top of the ladder to every caller for the whole load window.
        vi.mocked(getProject).mockReturnValue(new Promise(() => {}));
        renderWorkspace();

        expect(screen.getByTestId("role")).toHaveTextContent("null");
        expect(screen.getByTestId("can-delete")).toHaveTextContent("false");
        expect(screen.getByTestId("can-edit")).toHaveTextContent("false");
        expect(screen.getByTestId("role-known")).toHaveTextContent("false");
    });

    it("neither confirms nor refuses a delete while the role is unknown", async () => {
        vi.mocked(getProject).mockReturnValue(new Promise(() => {}));
        renderWorkspace();

        fireEvent.click(screen.getByText("delete project"));

        // Not the old fail-open: no confirmation for an action we cannot
        // know is allowed …
        expect(screen.queryByText("Delete project?")).not.toBeInTheDocument();
        // … and not a false accusation either, because the affordance that
        // produced this click is disabled in the real header.
        expect(
            screen.queryByText(/Only an admin can/),
        ).not.toBeInTheDocument();
    });

    it("does not open the new-review modal while the role is unknown", () => {
        vi.mocked(getProject).mockReturnValue(new Promise(() => {}));
        renderWorkspace();

        fireEvent.click(screen.getByText("new review"));

        expect(screen.queryByText("new review modal")).not.toBeInTheDocument();
        expect(screen.queryByText(/Only a member can/)).not.toBeInTheDocument();
    });

    it("opens the gates once the row arrives with an admin role", async () => {
        vi.mocked(getProject).mockResolvedValue(ADMIN_PROJECT);
        renderWorkspace();

        await waitFor(() =>
            expect(screen.getByTestId("role")).toHaveTextContent("admin"),
        );
        expect(screen.getByTestId("can-delete")).toHaveTextContent("true");
        expect(screen.getByTestId("role-known")).toHaveTextContent("true");

        fireEvent.click(screen.getByText("delete project"));
        expect(screen.getByText("Delete project?")).toBeInTheDocument();
    });

    it("refuses, and names an admin, once the row says viewer", async () => {
        vi.mocked(getProject).mockResolvedValue({
            ...ADMIN_PROJECT,
            access_role: "viewer",
            admin_contacts: [
                {
                    user_id: "u9",
                    email: "dana@firm.test",
                    display_name: "Dana Reyes",
                    source: "creator",
                },
            ],
        } as unknown as Project);
        renderWorkspace();

        await waitFor(() =>
            expect(screen.getByTestId("role")).toHaveTextContent("viewer"),
        );

        fireEvent.click(screen.getByText("delete project"));
        expect(
            screen.getByText("Only an admin can delete this project."),
        ).toBeInTheDocument();
        expect(
            screen.getByText(/Dana Reyes \(dana@firm.test\)/),
        ).toBeInTheDocument();
    });
});
