import { describe, expect, it } from "vitest";

import { SSE_KEEP_ALIVE_INTERVAL_MS, sseKeepAliveFrame } from "./sse";

// Two places in a chat turn park with nothing to say — the Word client tool
// loop waiting on the task pane, and an MCP confirmation waiting on a human.
// Both write these frames, so the invariants that make them safe are pinned
// once here rather than per call site.
describe("SSE keep-alive", () => {
    it("builds an SSE comment, which every reader in this repo drops", () => {
        // The frame's whole job is to be invisible: readers skip any line
        // that does not start with "data:". If this ever became a data frame
        // it would land in the transcript as an unknown event type.
        const frame = sseKeepAliveFrame("tool-wait");
        expect(frame.startsWith(":")).toBe(true);
        expect(frame.endsWith("\n\n")).toBe(true);
        expect(frame).not.toContain("data:");
    });

    it("carries the reason as a label only", () => {
        expect(sseKeepAliveFrame("mcp-approval")).toBe(": mcp-approval\n\n");
    });

    it("ticks well inside the shortest idle timeout we sit behind", () => {
        // nginx's proxy_read_timeout and an ELB idle timeout both default to
        // 60s; 30s is a common hardened setting. Two frames must fit inside
        // the tightest of those windows.
        expect(SSE_KEEP_ALIVE_INTERVAL_MS * 2).toBeLessThanOrEqual(30_000);
    });
});
