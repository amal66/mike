/// <reference types="office-js" />

const BASE_URL: string =
  process.env.REACT_APP_API_BASE_URL ?? "http://localhost:3001";

const STORAGE_KEY = "mike_token";

async function getToken(): Promise<string | null> {
  try {
    return await OfficeRuntime.storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

async function buildHeaders(includeContentType = true): Promise<Record<string, string>> {
  const token = await getToken();
  const headers: Record<string, string> = {};
  if (includeContentType) {
    headers["Content-Type"] = "application/json";
  }
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

async function get<T>(path: string): Promise<T> {
  const headers = await buildHeaders(false);
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "GET",
    headers,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${path} failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const headers = await buildHeaders(true);
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${path} failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<T>;
}

async function del<T>(path: string): Promise<T> {
  const headers = await buildHeaders(false);
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DELETE ${path} failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Stream a POST response as newline-delimited JSON or SSE.
 * Each line is parsed as JSON and the `content` (or `delta` / `text`) field
 * is forwarded to `onChunk`. Raw non-JSON lines are passed through as-is.
 */
async function stream(
  path: string,
  body: unknown,
  onChunk: (text: string) => void
): Promise<void> {
  const headers = await buildHeaders(true);
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`STREAM ${path} failed (${res.status}): ${text}`);
  }

  if (!res.body) {
    throw new Error("Response body is null — streaming not supported");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const processLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "data: [DONE]") return;

    // Support SSE format: "data: <json>" or raw JSON
    const jsonStr = trimmed.startsWith("data: ")
      ? trimmed.slice(6).trim()
      : trimmed;

    if (jsonStr === "[DONE]") return;

    try {
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
      // Handle multiple common chunk shapes
      const text =
        (parsed["content"] as string | undefined) ??
        (parsed["delta"] as string | undefined) ??
        (parsed["text"] as string | undefined) ??
        "";
      if (text) onChunk(text);
    } catch {
      // Not JSON — treat the raw string as a text delta
      if (jsonStr) onChunk(jsonStr);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    // Keep the last (potentially incomplete) line in the buffer
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      processLine(line);
    }
  }

  // Flush any remaining content in the buffer
  if (buffer.trim()) {
    processLine(buffer);
  }
}

export const apiClient = {
  get,
  post,
  delete: del,
  stream,
};
