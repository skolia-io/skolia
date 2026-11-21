// A spec made by hono-openapi from the marks on an app's routes' middleware (openapi.ts).
// Node only: what it imports turns schemas into JSON Schema, which a Worker doesn't need.
import type { Hono } from "hono";
import { generateSpecs, resolver, uniqueSymbol } from "hono-openapi";
import type { OpenAPIV3_1 } from "openapi-types";
import { MARK, type Mark, type Specs } from "./openapi.ts";

/** What hono-openapi reads from a middleware for the mark on it. */
function described(mark: Mark): object {
  switch (mark.kind) {
    case "validator":
      return { target: mark.target, ...resolver(mark.schema) };
    case "route":
      return { spec: mark.spec };
    case "responses":
      return { spec: { responses: responseObjects(mark.specs) } };
  }
}

function responseObjects(specs: Specs) {
  return Object.fromEntries(
    Object.entries(specs).map(([status, { description, schema }]) => [
      status,
      schema === undefined ? { description } : { description, content: { "application/json": { schema: resolver(schema) } } },
    ]),
  );
}

/** The spec of the app's routes. A request that doesn't fit its schema gets an
 * ApiError, which some route's schema must name so it's among the components. */
// Accept any Hono app environment, routes and base path.
type AnyHono = Hono<any, any, any>;

export async function openApiSpec(app: AnyHono, documentation: Partial<OpenAPIV3_1.Document>): Promise<OpenAPIV3_1.Document> {
  for (const { handler } of app.routes) {
    const mark = (handler as { [MARK]?: Mark })[MARK];
    if (mark !== undefined) Object.assign(handler, { [uniqueSymbol]: described(mark) });
  }
  return await generateSpecs(app, {
    documentation,
    defaultValidationErrorResponse: {
      description: "The request doesn't fit its schema",
      content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
    },
  });
}

/** The spec, as JSON has it. */
export async function specJson(app: AnyHono, documentation: Partial<OpenAPIV3_1.Document>): Promise<unknown> {
  return JSON.parse(JSON.stringify(await openApiSpec(app, documentation))) as unknown;
}
