/**
 * Shared server-sent-events primitives.
 *
 * A chat turn is a long-lived HTTP response, and there are points in it where
 * the server deliberately has nothing to say: the Word add-in's client tool
 * loop parks while the task pane executes an edit, and an MCP confirmation
 * parks while a human decides whether to allow a tool call. Both windows look
 * identical from the outside — an open response with no bytes flowing — and
 * that is exactly what proxies, load balancers, and CDNs reap for inactivity
 * (nginx's `proxy_read_timeout` and an ELB idle timeout both default to 60s;
 * 30s is a common hardened setting).
 *
 * Rather than let each pause invent its own answer, the cadence and the frame
 * shape live here once.
 */

/**
 * How often to write a keep-alive while a turn is parked.
 *
 * Must stay comfortably under the shortest idle timeout we can sit behind, so
 * that at least two frames land inside a 30s window.
 */
export const SSE_KEEP_ALIVE_INTERVAL_MS = 15_000;

/**
 * The bytes written on that cadence.
 *
 * This MUST stay an SSE *comment* — a line beginning with ":" terminated by a
 * blank line — because that is what makes it invisible: every SSE reader in
 * this repo (browser hook, Word task pane) skips any line that does not start
 * with "data:", so nothing lands in the transcript. Turning it into a data
 * frame would push an unknown event type into chat history.
 *
 * `reason` is a human-readable label for whoever is reading a tcpdump or a
 * proxy log; it carries no protocol meaning.
 */
export function sseKeepAliveFrame(reason: string): string {
    return `: ${reason}\n\n`;
}
