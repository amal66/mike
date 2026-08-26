import { describe, expect, it } from "vitest";

import { withoutEmptyAssistantReservations } from "../routeStreaming";

describe("withoutEmptyAssistantReservations", () => {
    it("drops assistant messages with null content (reservations)", () => {
        const messages = [
            { role: "user", content: "hi" },
            { role: "assistant", content: null },
            { role: "user", content: "again" },
        ];
        expect(withoutEmptyAssistantReservations(messages)).toEqual([
            { role: "user", content: "hi" },
            { role: "user", content: "again" },
        ]);
    });

    it("drops assistant messages whose content is empty or whitespace", () => {
        // A denied MCP confirmation leaves an assistant turn whose only
        // output was the tool interaction; clients replay it as "".
        // Providers reject empty assistant messages, so it must not pass.
        const messages = [
            { role: "user", content: "call the tool" },
            { role: "assistant", content: "" },
            { role: "assistant", content: "   " },
            { role: "user", content: "try again" },
        ];
        expect(withoutEmptyAssistantReservations(messages)).toEqual([
            { role: "user", content: "call the tool" },
            { role: "user", content: "try again" },
        ]);
    });

    it("keeps assistant messages with real content and all user messages", () => {
        const messages = [
            { role: "user", content: "" },
            { role: "assistant", content: "an answer" },
        ];
        expect(withoutEmptyAssistantReservations(messages)).toEqual(messages);
    });
});
