// What the API's OpenAPI spec says of each route, marked on its middleware with
// @skolia/util/openapi's helpers. spec.ts makes the spec, and just openapi writes it to
// api/openapi.json, which the Worker serves with two pages that render it.
import type { OpenAPIV3_1 } from "openapi-types";
import { json, redocPage, scalarPage } from "@skolia/util/openapi";
import * as schemas from "@skolia/shared/schemas";

export { MARK, NO_BODY, badRequest, describe, json, responses, validator, type Mark, type Spec, type Specs } from "@skolia/util/openapi";

export function error(description: string) {
  return json(schemas.ApiError, description);
}

export const NOT_SIGNED_IN = error("Not signed in");

/** A 429's header: when the client may try again. */
export const RETRY_AFTER = {
  "Retry-After": { description: "Seconds until the limit's window ends", schema: { type: "integer", minimum: 1 } },
} as const satisfies Record<string, OpenAPIV3_1.HeaderObject>;

/** Tags group the operations in the docs. */
export const TAGS = {
  account: "Account",
  cards: "Cards",
  documents: "Documents",
  annotations: "Annotations",
  reading: "Reading",
  ingest: "Ingest",
} as const;

/** Signed in with Better Auth's session cookie (GET /api/auth/*), or an API key. */
export const SIGNED_IN: OpenAPIV3_1.SecurityRequirementObject[] = [{ session: [] }, { apiKey: [] }];

/** Scalar's reference, which can also try requests, with the signed-in user's cookie. */
export const SCALAR_PAGE = scalarPage("skolia API", "/api/openapi.json");

export const REDOC_PAGE = redocPage("skolia API", "/api/openapi.json");
