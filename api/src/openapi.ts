// What the API's OpenAPI spec says of each route, marked on its middleware: request
// schemas on its validators, its summary and responses on describe() and responses(). The
// marks are plain data, so the Worker doesn't bundle what turns schemas into JSON Schema;
// spec.ts does that, and just openapi writes the spec to api/openapi.json, which the Worker
// serves with two pages that render it.
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { sValidator } from "@hono/standard-validator";
import type { MiddlewareHandler, ValidationTargets } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import type { OpenAPIV3_1 } from "openapi-types";
import type { ApiError } from "@skolia/shared/api";
import * as schemas from "@skolia/shared/schemas";

export const MARK = Symbol("openapi");

/** What a middleware says of its route. */
export type Mark =
  | { readonly kind: "validator"; readonly target: keyof ValidationTargets; readonly schema: StandardSchemaV1 }
  | { readonly kind: "route"; readonly spec: Readonly<Partial<OpenAPIV3_1.OperationObject>> & { readonly hide?: boolean } }
  | { readonly kind: "responses"; readonly specs: Specs };

function marked<H extends object>(handler: H, mark: Mark): H {
  return Object.assign(handler, { [MARK]: mark });
}

/** @hono/standard-validator's, with its target and schema marked for the spec. */
export const validator = ((target: keyof ValidationTargets, schema: StandardSchemaV1, hook?: Parameters<typeof sValidator>[2]) =>
  marked(sValidator(target, schema, hook), { kind: "validator", target, schema })) as typeof sValidator;

/** A route's summary and the like, in the spec; hide leaves it out. */
export function describe(spec: Extract<Mark, { kind: "route" }>["spec"]): MiddlewareHandler {
  return marked<MiddlewareHandler>(async (_c, next) => await next(), { kind: "route", spec });
}

/** A response a route sends: JSON its schema describes, or no body. */
export type Spec = { readonly description: string; readonly schema?: StandardSchemaV1 };

export type Specs = Readonly<Partial<Record<StatusCode, Spec>>>;

/** A route's responses, in the spec. With check, a response that isn't one of them, or whose
 * JSON doesn't fit its schema, becomes a 500 that says so: how the tests hold the spec to
 * what the API sends. It sees what the handler sends, so it goes after the validators. */
export function responses(specs: Specs, check: boolean): MiddlewareHandler {
  const checked: MiddlewareHandler = async (c, next) => {
    await next();
    if (!check) return;
    const problem = await mismatch(specs, c.res);
    if (problem !== null) c.res = c.json({ error: `the spec doesn't describe this response: ${problem}` } satisfies ApiError, 500);
  };
  return marked(checked, { kind: "responses", specs });
}

async function mismatch(specs: Specs, response: Response): Promise<string | null> {
  const spec = specs[response.status as StatusCode];
  if (spec === undefined) return `status ${response.status}`;
  if (spec.schema === undefined) return response.body === null ? null : `${response.status} has a body`;
  const result = await spec.schema["~standard"].validate(await response.clone().json());
  if (result.issues === undefined) return null;
  const issues = result.issues.map(
    (issue) => `${issue.path?.map((key) => (typeof key === "object" ? key.key : key)).join(".") ?? ""}: ${issue.message}`,
  );
  return `${response.status}: ${issues.join("; ")}`;
}

export function json<S extends StandardSchemaV1>(schema: S, description: string): { readonly description: string; readonly schema: S } {
  return { description, schema };
}

export function error(description: string) {
  return json(schemas.ApiError, description);
}

export const NO_BODY = { description: "Done; no body" } as const satisfies Spec;
export const NOT_SIGNED_IN = error("Not signed in");

/** Tags group the operations in the docs. */
export const TAGS = {
  account: "Account",
  cards: "Cards",
  documents: "Documents",
  annotations: "Annotations",
  reading: "Reading",
  lexicon: "Lexicon",
} as const;

/** Signed in with Better Auth's session cookie (GET /api/auth/*), or an API key. */
export const SIGNED_IN: OpenAPIV3_1.SecurityRequirementObject[] = [{ session: [] }, { apiKey: [] }];

const SCALAR = {
  src: "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.76.4/dist/browser/standalone.js",
  integrity: "sha384-hwB9WroDTpZaI38gr+u9CXA6ksz5gUYgD2GxXazKl/agT1L2GWUiRFWGJYNiFu4Q",
};

const REDOC = {
  src: "https://cdn.jsdelivr.net/npm/redoc@3.0.1/bundles/redoc.standalone.js",
  integrity: "sha384-j07qRKHNNmcwU1/Y1elJc7pDLHXP/QfbQXTtSkbOJ7uYGJikqAzsFVbY2zR9FqOT",
};

function page(body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>skolia API</title>
  </head>
  <body style="margin: 0">
    ${body}
  </body>
</html>
`;
}

/** Scalar's reference, which can also try requests, with the signed-in user's cookie. */
export const SCALAR_PAGE = page(`<div id="app"></div>
    <script src="${SCALAR.src}" integrity="${SCALAR.integrity}" crossorigin="anonymous"></script>
    <script>
      Scalar.createApiReference("#app", { url: "/api/openapi.json", withDefaultFonts: false });
    </script>`);

export const REDOC_PAGE = page(`<redoc spec-url="/api/openapi.json"></redoc>
    <script type="module" src="${REDOC.src}" integrity="${REDOC.integrity}" crossorigin="anonymous"></script>`);
