// How the analysis page describes jobs: their stages, how long things took, how long ago.
import type { IngestResult, IngestStage, LiveIngestJob, Timestamp } from "@skolia/shared/api";

export const STAGE_LABELS: Readonly<Record<IngestStage, string>> = {
  reading: "Reading the text",
  "loading-analysis": "Loading the stored analysis",
  analysing: "Analysing",
  bundling: "Bundling",
  "compressing-analysis": "Compressing the analysis",
  "uploading-analysis": "Uploading the analysis",
  "compressing-bundle": "Compressing the bundle",
  "uploading-bundle": "Uploading the bundle",
};

export const OUTCOME_LABELS: Readonly<Record<IngestResult["outcome"], string>> = {
  ready: "Ready",
  failed: "Failed",
  retried: "Retried",
};

/** 0.4 s, 12 s, 3 m 05 s, 1 h 02 m */
export function duration(ms: number): string {
  if (ms < 10_000) return `${(Math.max(ms, 0) / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} m ${String(seconds % 60).padStart(2, "0")} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} m`;
}

export function between(from: Timestamp, to: Timestamp | Date): number {
  return (to instanceof Date ? to.getTime() : Date.parse(to)) - Date.parse(from);
}

/** What a job in a container is doing now, and for how long */
export function liveStatus(job: LiveIngestJob, now: Date): string {
  if (job.startedAt === null) return `Waiting · ${duration(between(job.acceptedAt, now))}`;
  if (job.stage === null || job.stageStartedAt === null) return `Running · ${duration(between(job.startedAt, now))}`;
  return `${STAGE_LABELS[job.stage]} · ${duration(between(job.stageStartedAt, now))}`;
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function ago(at: Timestamp, now: Date): string {
  const ms = between(at, now);
  if (ms < 60_000) return "just now";
  if (ms < 60 * 60_000) return relative.format(-Math.floor(ms / 60_000), "minute");
  if (ms < 24 * 60 * 60_000) return relative.format(-Math.floor(ms / (60 * 60_000)), "hour");
  return relative.format(-Math.floor(ms / (24 * 60 * 60_000)), "day");
}
