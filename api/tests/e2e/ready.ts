import type { Version } from "@skolia/shared/api";
import { since } from "../../src/script-log.ts";
import { base, log, sleep, VERSION_TIMEOUT_MS } from "./client.ts";

const POLL_MS = 10_000;

// A new Worker's workers.dev name can take a while to answer (24 s for a preview's), so
// errors are retried until the deadline too
async function checkVersion(base: string, expected: string): Promise<void> {
  const deadline = Date.now() + VERSION_TIMEOUT_MS;
  for (;;) {
    let result: string;
    try {
      const response = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      const { version } = (await response.json()) as Version;
      if (version === expected) {
        log.info("version {version}", { version });
        return;
      }
      result = `serving ${version}, expected ${expected}`;
    } catch (error: unknown) {
      result = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() > deadline) throw new Error(`version: ${result}`);
    log.info("version: {result}", { result, expected });
    await sleep(POLL_MS);
  }
}

const expected = process.env["E2E_VERSION"];
if (!base || !expected) throw new Error("E2E_URL and E2E_VERSION are required");
const started = performance.now();
await checkVersion(base, expected);
log.info("version verified", { ms: since(started) });
