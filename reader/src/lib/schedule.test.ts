import assert from "node:assert/strict";
import { test } from "node:test";
import { timestamp } from "@skolia/shared/api";
import { scheduleLabel } from "./schedule.ts";

const NOW = new Date("2026-11-16T12:00:00Z");
const due = (iso: string) => ({ state: "learning" as const, scheduleStatus: "review" as const, dueAt: timestamp(new Date(iso)) });

test("a card's schedule says known, new, or when it's due", () => {
  assert.equal(scheduleLabel({ ...due("2026-11-10T00:00:00Z"), state: "known" }, NOW), "Known");
  assert.equal(scheduleLabel({ ...due("2026-11-10T00:00:00Z"), scheduleStatus: "new" }, NOW), "New");
  assert.equal(scheduleLabel(due("2026-11-16T12:00:00Z"), NOW), "Due now");
  assert.equal(scheduleLabel(due("2026-11-16T12:09:30Z"), NOW), "Due in 10 minutes");
  assert.equal(scheduleLabel(due("2026-11-16T17:00:00Z"), NOW), "Due in 5 hours");
  assert.equal(scheduleLabel(due("2026-11-19T12:00:00Z"), NOW), "Due in 3 days");
  assert.equal(scheduleLabel(due("2026-11-17T12:00:00Z"), NOW), "Due in 1 day");
});
