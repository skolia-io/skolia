// How the list of cards describes a card: its kind, and where it is in its schedule.
import type { Card } from "@skolia/shared/api";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Where a card is in its schedule, as of now: paused while its word isn't active, new
 * until it's first answered, then when it's due. */
export function scheduleLabel(card: Pick<Card, "active" | "scheduleStatus" | "dueAt">, now: Date): string {
  if (!card.active) return "Paused";
  if (card.scheduleStatus === "new") return "New";
  const ms = Date.parse(card.dueAt) - now.getTime();
  if (ms <= 0) return "Due now";
  const relative = new Intl.RelativeTimeFormat("en", { numeric: "always" });
  if (ms < HOUR_MS) return `Due ${relative.format(Math.ceil(ms / 60_000), "minute")}`;
  if (ms < DAY_MS) return `Due ${relative.format(Math.round(ms / HOUR_MS), "hour")}`;
  return `Due ${relative.format(Math.round(ms / DAY_MS), "day")}`;
}

export const CARD_KIND_LABELS: Readonly<Record<Card["kind"], string>> = {
  recognition: "Recognition",
  production: "Production",
  cloze: "Cloze",
};
