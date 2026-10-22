/**
 * Test doubles: a Pi model registry with fixed credentials, a model factory,
 * and a fetch implementation driven by a response queue. No network is used.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export interface FakeAuth {
  apiKey?: string;
  /** Simulate a thrown auth resolver error. */
  throws?: string;
  /** Hold getApiKeyAndHeaders until this promise settles. */
  wait?: Promise<void>;
  headers?: Record<string, string | null>;
  baseUrl?: string;
  ok?: boolean;
  error?: string;
  source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
  isOAuth?: boolean;
}

export function fakeModel(overrides: Partial<Model<any>> & Pick<Model<any>, "provider" | "id" | "baseUrl">): Model<any> {
  return {
    name: overrides.id,
    api: "openai-responses",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 1000,
    maxTokens: 100,
    ...overrides,
  } as Model<any>;
}

export function fakeRegistry(
  auth: FakeAuth | ((model: Model<any>) => FakeAuth),
  models: Model<any>[] = [],
): ModelRegistry {
  const authFor = (model: Model<any>): FakeAuth => (typeof auth === "function" ? auth(model) : auth);
  return {
    async getApiKeyAndHeaders(model: Model<any>) {
      const resolved = authFor(model);
      if (resolved.wait !== undefined) await resolved.wait;
      if (resolved.throws !== undefined) throw new Error(resolved.throws);
      if (resolved.ok === false) return { ok: false as const, error: resolved.error ?? "No API key found" };
      return {
        ok: true as const,
        ...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
        ...(resolved.headers !== undefined ? { headers: resolved.headers } : {}),
        ...(resolved.baseUrl !== undefined ? { baseUrl: resolved.baseUrl } : {}),
      };
    },
    getProviderAuthStatus(model: Model<any>) {
      return { configured: true, source: authFor(model).source ?? "environment" };
    },
    isUsingOAuth(model: Model<any>) {
      return authFor(model).isOAuth === true;
    },
    getAvailable() {
      return models;
    },
    getAll() {
      return models;
    },
  } as unknown as ModelRegistry;
}

export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

export function textResponse(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, { status: init.status ?? 200, headers: init.headers ?? {} });
}

export interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

export interface RecordedFetch {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
}

/** A fetch implementation that answers from a queue, repeating the last entry. */
export function sequenceFetch(queue: Array<Response | (() => Response | Promise<Response>)>): RecordedFetch {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    const rawHeaders = new Headers(init?.headers as Record<string, string> | undefined);
    rawHeaders.forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({ url, headers });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === undefined) throw new Error("no response queued");
    if (typeof next === "function") return await next();
    // Clone so a repeated queue entry still has an unread body.
    return next.clone();
  }) as typeof fetch;
  return { fetchImpl, calls };
}
