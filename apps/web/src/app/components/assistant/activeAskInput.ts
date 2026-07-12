import type { AssistantEvent, Message } from "../shared/types";

export type ActiveAskInput = {
    key: string;
    event: Extract<AssistantEvent, { type: "ask_inputs" }>;
};

/**
 * Return the unanswered ask-input request at the tail of a conversation.
 * A later response resolves it, and a later user turn means the conversation
 * has already moved on. Keeping this rule in one place prevents the global and
 * project chat surfaces from drifting apart.
 */
export function findActiveAskInput(messages: Message[]): ActiveAskInput | null {
    for (
        let messageIndex = messages.length - 1;
        messageIndex >= 0;
        messageIndex--
    ) {
        const message = messages[messageIndex];
        if (message.role === "user") return null;
        if (message.role !== "assistant" || !message.events) continue;

        for (
            let eventIndex = message.events.length - 1;
            eventIndex >= 0;
            eventIndex--
        ) {
            const event = message.events[eventIndex];
            if (event.type === "ask_inputs_response") return null;
            if (event.type === "ask_inputs") {
                return { key: `${messageIndex}-${eventIndex}`, event };
            }
        }
    }
    return null;
}
