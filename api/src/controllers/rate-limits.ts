// Holding users to rate limits (rate-limits.ts), unless their role grants unlimited-rate.
import { timestamp, type User } from "@skolia/shared/api";
import { log } from "@skolia/util/log";
import { hasPermission } from "../permissions.ts";
import type { Clock } from "../ports/index.ts";
import type { Permissions } from "../ports/permissions.ts";
import type { RateAction, UserRateLimits } from "../ports/users.ts";
import type { RateLimit } from "../rate-limits.ts";
import type { Failed } from "./result.ts";

const logger = log("rate-limits");

/** What an action's limit counts, in its error. */
const COUNTED: Readonly<Record<RateAction, string>> = { import: "imports" };

/** Counts the action against the user's limit: null if they may go ahead, else a 429 whose
 * Retry-After says when the window ends. */
export async function overLimit(
  deps: Clock & { users: UserRateLimits; permissions: Permissions },
  user: User,
  action: RateAction,
  limit: RateLimit,
): Promise<Failed<429> | null> {
  if (await hasPermission(deps, user, "unlimited-rate")) return null;
  const outcome = await deps.users.take(user.id, action, timestamp(deps.now()), limit);
  switch (outcome.kind) {
    case "taken":
      return null;
    case "limited": {
      const { retryAfterSeconds } = outcome;
      logger.info("rate limited", { user: user.id, action, limit: limit.limit, windowSeconds: limit.windowSeconds, retryAfterSeconds });
      return {
        status: 429,
        body: {
          error: `at most ${limit.limit} ${COUNTED[action]} every ${limit.windowSeconds} seconds; try again in ${retryAfterSeconds}`,
        },
        headers: { "retry-after": String(retryAfterSeconds) },
      };
    }
    default: {
      const unknown: never = outcome;
      throw new Error(`unknown rate outcome ${JSON.stringify(unknown)}`);
    }
  }
}
