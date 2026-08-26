import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { can, type Capability, type ProjectRole } from "@/app/lib/permissions";
import { ProjectDocumentsView } from "./ProjectDocumentsView";

// Everything below the toolbar is out of scope here: this file pins WHICH
// role sees the folder affordances, not what DocTable does with them.
vi.mock("@/app/components/documents/DocTable", () => ({
    DocTable: () => <div data-testid="doc-table" />,
}));
vi.mock("@/app/components/modals/AddDocumentsModal", () => ({
    AddDocumentsModal: () => null,
}));
vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/app/lib/mikeApi", () => ({
    createProjectFolder: vi.fn(),
    deleteProjectFolder: vi.fn(),
    getProject: vi.fn().mockResolvedValue({ id: "p1", documents: [] }),
    moveDocumentToFolder: vi.fn(),
    moveSubfolderToFolder: vi.fn(),
    renameProjectDocument: vi.fn(),
    renameProjectFolder: vi.fn(),
    resolveProjectFolderPath: vi.fn(),
    uploadProjectDocument: vi.fn(),
    getProjectDirectoryLevel: vi.fn(),
}));

const role = vi.hoisted(() => ({ current: "member" as ProjectRole }));

vi.mock("./ProjectWorkspace", () => ({
    ProjectSectionToolbar: ({ actions }: { actions?: ReactNode }) => (
        <div>{actions}</div>
    ),
    useProjectWorkspace: () => ({
        projectId: "p1",
        project: {
            id: "p1",
            name: "Matter",
            documents: [],
            folders: [],
        },
        setProject: vi.fn(),
        folders: [],
        setFolders: vi.fn(),
        projectLoading: false,
        search: "",
        prefetchProjectSections: vi.fn(),
        setOwnerOnlyAction: vi.fn(),
        setDocumentFolderBreadcrumbs: vi.fn(),
        setAddDocumentsHeaderAction: vi.fn(),
        accessRole: role.current,
        canDo: (capability: Capability) => can(role.current, capability),
    }),
}));

function renderAs(next: ProjectRole) {
    role.current = next;
    return render(<ProjectDocumentsView projectId="p1" />);
}

describe("ProjectDocumentsView folder affordances", () => {
    it("offers folder operations to members", () => {
        // Will's review: member is the normal collaborator and organizes
        // folders. This used to sit behind the removed manager tier, so a
        // member saw no Folder button at all.
        renderAs("member");
        expect(screen.getByText("Folder")).toBeInTheDocument();
        expect(screen.getByText("Upload folder")).toBeInTheDocument();
    });

    it("offers folder operations to admins", () => {
        renderAs("admin");
        expect(screen.getByText("Folder")).toBeInTheDocument();
        expect(screen.getByText("Upload folder")).toBeInTheDocument();
    });

    it("withholds them from viewers", () => {
        renderAs("viewer");
        expect(screen.queryByText("Folder")).not.toBeInTheDocument();
        expect(screen.queryByText("Upload folder")).not.toBeInTheDocument();
    });
});
