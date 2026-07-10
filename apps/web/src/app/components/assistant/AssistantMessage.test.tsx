import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AssistantEvent, EditAnnotation } from "../shared/types";
import { AssistantMessage } from "./AssistantMessage";

/* EditCard imports the browser Supabase client at module scope; it is never
   exercised by these assertions, so a bare stub keeps jsdom out of the network. */
vi.mock("@/app/lib/supabase", () => ({ supabase: {} }));

function annotation(n: number): EditAnnotation {
    return {
        edit_id: `edit-${n}`,
        document_id: "doc-1",
        version_id: "v1",
        change_id: `change-${n}`,
        deleted_text: `old ${n}`,
        inserted_text: `new ${n}`,
        status: "pending",
    } as EditAnnotation;
}

function docEdited(count: number): AssistantEvent {
    return {
        type: "doc_edited",
        filename: "contract.docx",
        document_id: "doc-1",
        version_id: "v1",
        download_url: "https://example.test/doc.docx",
        annotations: Array.from({ length: count }, (_, i) => annotation(i + 1)),
        isStreaming: false,
    } as AssistantEvent;
}

/* The change number is rendered by EditCard as a bare index above the card.
   Scope the query to that element so the assertions can't latch onto the
   diff text, which also contains digits. */
const changeNumbers = () =>
    Array.from(document.querySelectorAll("p.text-xs.text-gray-400")).map(
        (el) => el.textContent,
    );

describe("AssistantMessage edit-card numbering", () => {
    it("omits the change number when a reply proposes a single edit", () => {
        render(<AssistantMessage events={[docEdited(1)]} />);

        // A lone "1" above the only card is noise, so no number is rendered.
        expect(changeNumbers()).toEqual([]);
    });

    it("numbers the cards 1..n when a reply proposes several edits", () => {
        render(<AssistantMessage events={[docEdited(3)]} />);

        expect(changeNumbers()).toEqual(["1", "2", "3"]);
    });

    it("numbers continuously across edits to more than one document", () => {
        const first = docEdited(2);
        const second = {
            ...(docEdited(1) as Record<string, unknown>),
            document_id: "doc-2",
            filename: "schedule.docx",
            annotations: [{ ...annotation(9), document_id: "doc-2" }],
        } as AssistantEvent;

        render(<AssistantMessage events={[first, second]} />);

        // The counter is per-message, not per-document.
        expect(changeNumbers()).toEqual(["1", "2", "3"]);
    });

    it("renders a card per proposed edit", () => {
        render(<AssistantMessage events={[docEdited(2)]} />);

        expect(screen.getAllByText(/new [12]/)).toHaveLength(2);
    });
});
