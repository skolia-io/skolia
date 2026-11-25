// What an OpenAPI spec says of each route, marked on its middleware: request schemas on its
// validators, its summary and responses on describe() and responses(). The marks are plain
// data, so a Worker doesn't bundle what turns schemas into JSON Schema; openapi-spec.ts
// does that, in Node, for the spec a Worker serves. The API (api/src/openapi.ts) and the
// lexicon (lexicon-api/src/app.ts) both mark their routes this way.
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { sValidator } from "@hono/standard-validator";
import type { Context, Env, MiddlewareHandler, ValidationTargets } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import type { OpenAPIV3_1 } from "openapi-types";

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

/** A validator's hook: a 400 with the path of the first invalid field. */
export function badRequest() {
  return <E extends Env, P extends string>(
    result: { success: true } | { success: false; error: readonly StandardSchemaV1.Issue[] },
    c: Context<E, P>,
  ) => {
    if (result.success) return undefined;
    const path = (result.error[0]?.path ?? []).map((part) => {
      const key = typeof part === "object" ? part.key : part;
      return typeof key === "number" ? key : String(key);
    });
    return c.json({ error: { code: "invalid-request" as const, path } }, 400);
  };
}

/** A route's summary and the like, in the spec; hide leaves it out. */
export function describe(spec: Extract<Mark, { kind: "route" }>["spec"]): MiddlewareHandler {
  return marked<MiddlewareHandler>(async (_c, next) => await next(), { kind: "route", spec });
}

/** A response a route sends: JSON its schema describes, or no body, and the headers it always has. */
export type Spec = {
  readonly description: string;
  readonly schema?: StandardSchemaV1;
  readonly headers?: Readonly<Record<string, OpenAPIV3_1.HeaderObject>>;
};

export type Specs = Readonly<Partial<Record<StatusCode, Spec>>>;

/** A route's responses, in the spec. With check, a response that isn't one of them, or whose
 * JSON doesn't fit its schema, becomes a 500 that says so: how the tests hold the spec to
 * what a Worker sends. It sees what the handler sends, so it goes after the validators. */
export function responses(specs: Specs, check: boolean): MiddlewareHandler {
  const checked: MiddlewareHandler = async (c, next) => {
    await next();
    if (!check) return;
    const problem = await mismatch(specs, c.res);
    if (problem !== null) c.res = c.json({ error: `the spec doesn't describe this response: ${problem}` }, 500);
  };
  return marked(checked, { kind: "responses", specs });
}

async function mismatch(specs: Specs, response: Response): Promise<string | null> {
  const spec = specs[response.status as StatusCode];
  if (spec === undefined) return `status ${response.status}`;
  const missing = Object.keys(spec.headers ?? {}).filter((name) => !response.headers.has(name));
  if (missing.length > 0) return `${response.status} has no ${missing.join(", ")}`;
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

export const NO_BODY = { description: "Done; no body" } as const satisfies Spec;

const SCALAR = {
  src: "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.76.4/dist/browser/standalone.js",
  integrity: "sha384-hwB9WroDTpZaI38gr+u9CXA6ksz5gUYgD2GxXazKl/agT1L2GWUiRFWGJYNiFu4Q",
};

const REDOC = {
  src: "https://cdn.jsdelivr.net/npm/redoc@3.0.1/bundles/redoc.standalone.js",
  integrity: "sha384-j07qRKHNNmcwU1/Y1elJc7pDLHXP/QfbQXTtSkbOJ7uYGJikqAzsFVbY2zR9FqOT",
};

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body style="margin: 0">
    ${body}
  </body>
</html>
`;
}

/** Scalar's reference of the spec at specUrl, which can also try requests. */
export function scalarPage(title: string, specUrl: string): string {
  return page(
    title,
    `<div id="app"></div>
    <script src="${SCALAR.src}" integrity="${SCALAR.integrity}" crossorigin="anonymous"></script>
    <script>
      Scalar.createApiReference("#app", { url: "${specUrl}", withDefaultFonts: false });
    </script>`,
  );
}

export function redocPage(title: string, specUrl: string): string {
  return page(
    title,
    `<redoc spec-url="${specUrl}"></redoc>
    <script type="module" src="${REDOC.src}" integrity="${REDOC.integrity}" crossorigin="anonymous"></script>`,
  );
}
