/**
 * Read-only HTTP GET with the credential-safety rules of this package:
 * HTTPS by default (plain HTTP only for loopback or an explicitly configured
 * local origin), no URL userinfo, no redirects, a hard timeout, and a body cap.
 * The caller must name the origins it allows the credential to reach.
 */

export interface HttpPolicy {
  timeoutMs: number;
  maxBodyBytes: number;
}

export const DEFAULT_HTTP_POLICY: HttpPolicy = {
  timeoutMs: 8000,
  maxBodyBytes: 256 * 1024,
};

export class UsageUrlError extends Error {
  readonly reason: "protocol" | "userinfo" | "invalid" | "http-origin";

  constructor(reason: UsageUrlError["reason"], message: string) {
    super(message);
    this.name = "UsageUrlError";
    this.reason = reason;
  }
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return host === "localhost" || host === "::1" || host === "127.0.0.1" || host.startsWith("127.");
}

/**
 * Parse an absolute http(s) URL and reject userinfo, unsupported protocols, and
 * plain HTTP to a non-loopback host unless `allowInsecureHttp` is set.
 */
export function parseSafeUrl(raw: string, options: { allowInsecureHttp?: boolean } = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageUrlError("invalid", "URL is not absolute");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UsageUrlError("protocol", `Unsupported URL protocol ${url.protocol}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new UsageUrlError("userinfo", "URLs with userinfo are not allowed");
  }
  if (url.protocol === "http:" && !options.allowInsecureHttp && !isLoopbackHost(url.hostname)) {
    throw new UsageUrlError("http-origin", "Plain HTTP is only allowed for loopback or explicitly configured local origins");
  }
  return url;
}

export type HttpOutcome =
  | { kind: "response"; status: number; headers: Record<string, string>; body: string }
  | {
      kind: "error";
      reason: "origin" | "unsafe-url" | "redirect" | "timeout" | "aborted" | "body-too-large" | "network";
      message: string;
    };

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

/** Close a response body we will not read; a body that is already gone is fine. */
function cancelResponseBody(response: Response): void {
  const body = response.body;
  if (body === null) return;
  try {
    void body.cancel().catch(() => undefined);
  } catch {
    // A locked or already-consumed body needs no cancellation.
  }
}

async function readBoundedBody(response: Response, maxBodyBytes: number): Promise<string | { error: string }> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBodyBytes) {
        // Do not await cancel(): with a teed body it can wait on the sibling
        // branch, and an oversized response must fail promptly.
        void reader.cancel().catch(() => undefined);
        return { error: `response body exceeded ${maxBodyBytes} bytes` };
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A released or errored reader is already unusable; nothing to do.
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * GET a URL that must belong to one of `allowedOrigins`. Redirects are not
 * followed: a 3xx response becomes a hard error so credentials can never travel
 * to a host that was not checked before the request.
 */
export async function httpGet(
  url: URL,
  init: { headers: Record<string, string>; allowedOrigins: readonly string[] },
  policy: HttpPolicy,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<HttpOutcome> {
  if (url.username !== "" || url.password !== "") {
    return { kind: "error", reason: "unsafe-url", message: "URLs with userinfo are not allowed" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { kind: "error", reason: "unsafe-url", message: `Unsupported URL protocol ${url.protocol}` };
  }
  if (!init.allowedOrigins.includes(url.origin)) {
    return {
      kind: "error",
      reason: "origin",
      message: "refusing a credentialed request to an unapproved origin",
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort();
  if (signal !== undefined) {
    if (signal.aborted) return { kind: "error", reason: "aborted", message: "request aborted" };
    signal.addEventListener("abort", abortFromParent, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, policy.timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: init.headers,
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      // The redirect is refused, so its response ends here: close the body we
      // will not read and abort the request, so a long-lived body cannot keep
      // the connection open beyond the configured timeout.
      cancelResponseBody(response);
      controller.abort();
      return {
        kind: "error",
        reason: "redirect",
        message: `Authenticated redirect rejected (HTTP ${response.status})`,
      };
    }
    const headers = headersToRecord(response.headers);
    const body = await readBoundedBody(response, policy.maxBodyBytes);
    if (typeof body !== "string") {
      return { kind: "error", reason: "body-too-large", message: body.error };
    }
    return { kind: "response", status: response.status, headers, body };
  } catch (error) {
    if (timedOut) {
      return { kind: "error", reason: "timeout", message: `request timed out after ${policy.timeoutMs}ms` };
    }
    if (signal?.aborted === true) {
      return { kind: "error", reason: "aborted", message: "request aborted" };
    }
    // Fetch implementations can embed request/header values in construction
    // errors. Reports must never expose arbitrary exception text, so network
    // failures use one fixed public category.
    return {
      kind: "error",
      reason: "network",
      message: "network request failed",
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromParent);
  }
}
