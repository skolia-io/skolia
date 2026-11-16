// Resolves every curated text as the sync would, fetching those whose kind names a source,
// without an API to sync to: for CI's check-curated job, so a pull request that only
// changes curated/ finds a text that can't be had before it reaches the sync.
// usage: node src/check-curated.ts <curated dir>
import { runScript, scriptLog, since } from "./script-log.ts";
import { readCurated, resolveCurated } from "./sync-curated.ts";

const log = scriptLog("check-curated");

async function main(): Promise<void> {
  const [, , dir] = process.argv;
  if (!dir) {
    console.error("usage: node src/check-curated.ts <curated dir>");
    process.exit(2);
  }
  const start = performance.now();
  const texts = await resolveCurated(await readCurated(dir));
  log.info("resolved {texts} texts", { texts: texts.length, ms: since(start) });
}

if (import.meta.main) await runScript(log, main);
