import { describe, expect, it } from "vitest";
import type { AssistantEvent, Message } from "../shared/types";
import { findActiveAskInput } from "./activeAskInput";

const request = {
    type: "ask_inputs",
    items: [],
} as Extract<AssistantEvent, { type: "ask_inputs" }>;
const response = {
    type: "ask_inputs_response",
    responses: [],
} as Extract<AssistantEvent, { type: "ask_inputs_response" }>;

const assistant = (events: AssistantEvent[]): Message => ({
    role: "assistant",
    events,
});

describe("findActiveAskInput", () => {
    it("returns the latest unanswered request", () => {
        expect(findActiveAskInput([assistant([request])])).toEqual({
            key: "0-0",
            event: request,
        });
    });

    it("treats a later response in the same assistant turn as resolved", () => {
        expect(findActiveAskInput([assistant([request, response])])).toBeNull();
    });

    it("does not resurrect a request once a later user turn exists", () => {
        expect(
            findActiveAskInput([
                assistant([request]),
                { role: "user", content: "continue" },
            ]),
        ).toBeNull();
    });

    it("uses the latest trailing assistant message and a stable event key", () => {
        expect(
            findActiveAskInput([
                { role: "user", content: "review this" },
                assistant([]),
                assistant([{ type: "text", content: "One question" }, request]),
            ]),
        ).toEqual({ key: "2-1", event: request });
    });
});
