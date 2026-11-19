import { hc } from "hono/client";
import type { AppType } from "../../src/app.ts";
import { API_KEY_HEADER } from "../../src/auth.ts";
import { configureScriptLog, scriptLog } from "../../src/script-log.ts";

configureScriptLog();
export const log = scriptLog("e2e");
const POLL_MS = 10_000;
const FETCH_RETRIES = 3;
const FETCH_RETRY_DELAY_MS = 500;
export const VERSION_TIMEOUT_MS = 120_000;
export const base = process.env["E2E_URL"]?.replace(/\/$/, "") ?? "";
export const systemKey = process.env["E2E_API_KEY"] ?? "";
export const runId = process.env["E2E_RUN_ID"] ?? "";

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a response is Cloudflare's own 404 page, which says no Worker answered, rather
 * than one of the API's, which aren't HTML. */
const isEdge404 = (response: Response) => response.status === 404 && (response.headers.get("content-type") ?? "").startsWith("text/html");

/** Retry the edge 404 while a new Worker's workers.dev name propagates. Retry network
 * failures on reads: a write whose response was lost may already have reached the Worker. */
export async function retryingFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : undefined;
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const url = request?.url ?? String(input);
  const deadline = Date.now() + VERSION_TIMEOUT_MS;
  let retries = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(input, { ...init, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      // Node's fetch reports transport errors, including ECONNRESET, through this TypeError.
      const networkFailure = error instanceof TypeError && error.message === "fetch failed";
      const delay = FETCH_RETRY_DELAY_MS * 2 ** retries;
      if ((method !== "GET" && method !== "HEAD") || !networkFailure || retries >= FETCH_RETRIES || Date.now() + delay > deadline) {
        log.error("request failed", { method, url, error });
        throw error;
      }
      retries += 1;
      log.warn("network request failed; trying again", { method, url, retry: retries, ms: delay, error });
      await sleep(delay);
      continue;
    }
    if (!isEdge404(response) || Date.now() > deadline) return response;
    log.info("Cloudflare's 404; trying again", { method, url });
    await response.body?.cancel();
    await sleep(POLL_MS);
  }
}

export type Api = ReturnType<typeof hc<AppType>>["api"];

export function client(base: string, key?: string): Api {
  return hc<AppType>(base, { fetch: retryingFetch, ...(key === undefined ? {} : { headers: { [API_KEY_HEADER]: key } }) }).api;
}

/** A URL the typed client doesn't describe (text and blobs, which aren't JSON), as the
 * key's user if given. */
export async function fetchOk(what: string, url: string, key?: string): Promise<Response> {
  const response = await retryingFetch(url, key === undefined ? {} : { headers: { [API_KEY_HEADER]: key } });
  if (!response.ok) throw new Error(`${what}: ${response.status}: ${await response.text()}`);
  return response;
}
