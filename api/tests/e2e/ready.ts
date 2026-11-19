import type { Version } from "@skolia/shared/api";
import { since } from "../../src/script-log.ts";
import { base, log, sleep, VERSION_TIMEOUT_MS } from "./client.ts";

// A new preview may take time to start serving the deployed version.
async function checkVersion(expected: string): Promise<void> {
  const started = performance.now();
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
        log.info("version verified", { version, ms: since(started) });
        return;
      }
      result = `serving ${version}, expected ${expected}`;
    } catch (error: unknown) {
      result = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() > deadline) throw new Error(`version: ${result}`);
    log.info("version: {result}", { result, expected });
    await sleep(10_000);
  }
}

const expected = process.env["E2E_VERSION"];
if (!base || !expected) throw new Error("E2E_URL and E2E_VERSION are required");
await checkVersion(expected);
