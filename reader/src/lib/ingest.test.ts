import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiveIngestJob, Timestamp } from "@skolia/shared/api";
import { ago, duration, liveStatus } from "./ingest.ts";

const at = (time: string) => `2026-11-17T${time}.000Z` as Timestamp;
const NOW = new Date("2026-11-17T10:00:00.000Z");

test("a duration is tenths of a second, then seconds, minutes and hours", () => {
  assert.equal(duration(400), "0.4 s");
  assert.equal(duration(9_960), "10.0 s");
  assert.equal(duration(12_300), "12 s");
  assert.equal(duration(185_000), "3 m 05 s");
  assert.equal(duration(3_720_000), "1 h 02 m");
  assert.equal(duration(-5), "0.0 s");
});

test("a live job says it's waiting, or which stage it's in, and for how long", () => {
  const job: LiveIngestJob = {
    id: "j",
    document: null,
    lang: "pl",
    acceptedAt: at("09:58:00"),
    startedAt: null,
    stage: null,
    stageStartedAt: null,
    chars: null,
    words: null,
    stages: [],
  };
  assert.equal(liveStatus(job, NOW), "Waiting · 2 m 00 s");
  assert.equal(
    liveStatus({ ...job, startedAt: at("09:59:00"), stage: "analysing", stageStartedAt: at("09:59:30") }, NOW),
    "Analysing · 30 s",
  );
});

test("how long ago is in the largest whole unit", () => {
  assert.equal(ago(at("09:59:30"), NOW), "just now");
  assert.equal(ago(at("09:45:00"), NOW), "15 minutes ago");
  assert.equal(ago(at("07:00:00"), NOW), "3 hours ago");
});
