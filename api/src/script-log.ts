// Structured logs for the scripts run from a shell or CI (sync-curated.ts, e2e.ts), as
// logfmt lines, or JSON Lines with LOG_FORMAT=json. Their loggers are under skolia-script,
// which the Workers' log.ts doesn't configure, so a test that calls a script's functions
// stays quiet.
import { configureSync, getConsoleSink, getLogger, jsonLinesFormatter, logfmtFormatter, type Logger } from "@logtape/logtape";
import { describeError, errorFields } from "./errors.ts";

/** A script's logger, e.g. scriptLog("sync-curated") for skolia-script.sync-curated */
export function scriptLog(name: string): Logger {
  return getLogger(["skolia-script", name]);
}

/** Sends the scripts' logs to the console. Only a script's main calls it. */
export function configureScriptLog(): void {
  const formatter = process.env["LOG_FORMAT"] === "json" ? jsonLinesFormatter : logfmtFormatter;
  configureSync({
    reset: true,
    sinks: { console: getConsoleSink({ formatter }) },
    loggers: [
      { category: ["skolia-script"], sinks: ["console"], lowestLevel: "info" },
      { category: ["logtape", "meta"], sinks: ["console"], lowestLevel: "warning" },
    ],
  });
}

/** Runs a script's main with its logs configured, logging what it throws and exiting 1. */
export async function runScript(log: Logger, main: () => Promise<void>): Promise<void> {
  configureScriptLog();
  try {
    await main();
  } catch (error) {
    log.with({ error: errorFields(error) }).fatal`${describeError(error)}`;
    process.exitCode = 1;
  }
}

/** Milliseconds since start, for a record's ms */
export function since(start: number): number {
  return Math.round(performance.now() - start);
}
