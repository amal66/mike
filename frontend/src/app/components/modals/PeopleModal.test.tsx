import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PeopleModal } from "./PeopleModal";

vi.mock("@/app/lib/mikeApi", () => ({
    lookupUserByEmail: vi.fn().mockResolvedValue({
        exists: true,
        email: "known@firm.example",
        display_name: "Known",
    }),
}));

const PROJECT = {
    id: "p1",
    shared_with: ["counsel@outside.example"],
    owner_email: "creator@firm.example",
    owner_display_name: "Creator",
};

function peopleResponse() {
    return Promise.resolve({
        owner: {
            user_id: "u1",
            email: "creator@firm.example",
            display_name: "Creator",
            role: "admin" as const,
        },
        members: [
            {
                email: "counsel@outside.example",
                display_name: null,
                role: "viewer" as const,
            },
        ],
    });
}

function renderRoleAware(overrides?: {
    canManage?: boolean;
    orgId?: string | null;
    onGrant?: (email: string, role: string) => Promise<void>;
    onRevoke?: (email: string) => Promise<void>;
}) {
    const onGrant = overrides?.onGrant ?? vi.fn().mockResolvedValue(undefined);
    const onRevoke =
        overrides?.onRevoke ?? vi.fn().mockResolvedValue(undefined);
    render(
        <PeopleModal
            open
            onClose={vi.fn()}
            resource={PROJECT}
            fetchPeople={peopleResponse}
            currentUserEmail="me@firm.example"
            breadcrumb={["Projects", "Matter", "People"]}
            access={{
                grants: [
                    { email: "counsel@outside.example", role: "viewer" },
                ],
                orgId: overrides?.orgId ?? null,
                canManage: overrides?.canManage ?? true,
                onGrant: onGrant as never,
                onRevoke,
            }}
        />,
    );
    return { onGrant, onRevoke };
}

describe("PeopleModal — per-recipient roles", () => {
    it("offers Admin, Member and Viewer for each recipient", async () => {
        renderRoleAware();
        const select = await screen.findByLabelText(
            "Role for counsel@outside.example",
        );
        expect(
            within(select).getAllByRole("option").map((o) => o.textContent),
        ).toEqual(["Admin", "Member", "Viewer"]);
        expect((select as HTMLSelectElement).value).toBe("viewer");
    });

    it("re-roles a recipient through the grants API", async () => {
        const user = userEvent.setup();
        const { onGrant } = renderRoleAware();
        await user.selectOptions(
            await screen.findByLabelText("Role for counsel@outside.example"),
            "admin",
        );
        await waitFor(() =>
            expect(onGrant).toHaveBeenCalledWith(
                "counsel@outside.example",
                "admin",
            ),
        );
    });

    it("shares with an address that has no account yet", async () => {
        const user = userEvent.setup();
        const { onGrant } = renderRoleAware();
        await user.selectOptions(
            await screen.findByLabelText("Role for the new recipient"),
            "viewer",
        );
        await user.type(
            screen.getByPlaceholderText("Add by email..."),
            "newcounsel@outside.example",
        );
        await user.click(screen.getByRole("button", { name: "Add" }));
        await waitFor(() =>
            expect(onGrant).toHaveBeenCalledWith(
                "newcounsel@outside.example",
                "viewer",
            ),
        );
    });

    it("revokes a grant", async () => {
        const user = userEvent.setup();
        const { onRevoke } = renderRoleAware();
        await screen.findByLabelText("Role for counsel@outside.example");
        await user.click(screen.getByTitle("Member actions"));
        await user.click(
            screen.getByRole("button", { name: /remove access/i }),
        );
        await waitFor(() =>
            expect(onRevoke).toHaveBeenCalledWith("counsel@outside.example"),
        );
    });

    it("shows roles read-only to somebody who cannot manage access", async () => {
        renderRoleAware({ canManage: false });
        expect(await screen.findByText("Viewer")).toBeInTheDocument();
        expect(
            screen.queryByLabelText("Role for counsel@outside.example"),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByPlaceholderText("Add by email..."),
        ).not.toBeInTheDocument();
    });

    it("explains that an organization's project is already reachable by its people", async () => {
        renderRoleAware({ orgId: "org-1" });
        expect(
            await screen.findByText(/belongs to an organization/),
        ).toBeInTheDocument();
    });

    it("labels the creator Admin, never Owner", async () => {
        renderRoleAware();
        expect(await screen.findByText("Admin")).toBeInTheDocument();
        expect(screen.queryByText("Owner")).not.toBeInTheDocument();
    });
});

describe("PeopleModal — roleless resources", () => {
    it("keeps the shared_with list path for reviews and shows no role picker", async () => {
        const onSharedWithChange = vi.fn().mockResolvedValue(undefined);
        render(
            <PeopleModal
                open
                onClose={vi.fn()}
                resource={{
                    id: "r1",
                    shared_with: ["colleague@firm.example"],
                }}
                fetchPeople={() =>
                    Promise.resolve({
                        owner: {
                            user_id: "u1",
                            email: "creator@firm.example",
                            display_name: null,
                        },
                        members: [
                            {
                                email: "colleague@firm.example",
                                display_name: null,
                            },
                        ],
                    })
                }
                currentUserEmail="me@firm.example"
                breadcrumb={["Tabular Reviews", "Review", "People"]}
                onSharedWithChange={onSharedWithChange}
            />,
        );
        expect(await screen.findByText("Member")).toBeInTheDocument();
        expect(
            screen.queryByLabelText("Role for colleague@firm.example"),
        ).not.toBeInTheDocument();
    });
});
