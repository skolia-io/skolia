// A spec made by hono-openapi from the marks on an app's routes' middleware (openapi.ts).
// Node only: what it imports turns schemas into JSON Schema, which a Worker doesn't need.
import type { Hono } from "hono";
import type { StandardSchemaV1 } from "@standard-schema/spec";
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
    Object.entries(specs).map(([status, { description, schema, headers }]) => [
      status,
      {
        description,
        ...(headers === undefined ? {} : { headers }),
        ...(schema === undefined ? {} : { content: { "application/json": { schema: resolver(schema) } } }),
      },
    ]),
  );
}

// Accept any Hono app environment, routes and base path.
type AnyHono = Hono<any, any, any>;

/** The spec of the app's routes. An explicit 400 takes precedence over the validation error. */
export async function openApiSpec(
  app: AnyHono,
  documentation: Partial<OpenAPIV3_1.Document>,
  validationError: StandardSchemaV1,
): Promise<OpenAPIV3_1.Document> {
  for (const { handler } of app.routes) {
    const mark = (handler as { [MARK]?: Mark })[MARK];
    if (mark !== undefined) Object.assign(handler, { [uniqueSymbol]: described(mark) });
  }
  const { schema } = await resolver(validationError).toOpenAPISchema();
  return await generateSpecs(app, {
    documentation,
    defaultValidationErrorResponse: {
      description: "The request doesn't fit its schema",
      content: { "application/json": { schema } },
    },
  });
}

/** The spec, as JSON has it. */
export async function specJson(
  app: AnyHono,
  documentation: Partial<OpenAPIV3_1.Document>,
  validationError: StandardSchemaV1,
): Promise<unknown> {
  return JSON.parse(JSON.stringify(await openApiSpec(app, documentation, validationError))) as unknown;
}
