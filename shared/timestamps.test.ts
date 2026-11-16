import assert from "node:assert/strict";
import { test } from "node:test";
import * as z from "zod";
import * as schemas from "./schemas.ts";

/** Fields that hold a time but keep an older name, each with the git-bug issue to rename it. */
const allowed: ReadonlyMap<string, string> = new Map([["Status.updated", "52f9392: stored in R2 status blobs"]]);

/** A place in a schema: its path from the export, the object key it's under (null for an
 * array's element, a tuple's item or a record's key or value), and the schema there. */
type Place = { readonly path: string; readonly name: string | null; readonly schema: z.core.$ZodType };

function places(schema: z.core.$ZodType, path: string, name: string | null, above: ReadonlySet<z.core.$ZodType>): readonly Place[] {
  if (above.has(schema)) return [];
  const within = new Set([...above, schema]);
  const inner = (s: z.core.$ZodType, p = path, n = name) => places(s, p, n, within);
  const def = (schema as z.core.$ZodTypes)._zod.def;
  const below = (() => {
    switch (def.type) {
      case "object":
        return [
          ...Object.entries(def.shape).flatMap(([key, value]) => inner(value, `${path}.${key}`, key)),
          ...(def.catchall === undefined ? [] : inner(def.catchall, `${path}.*`, null)),
        ];
      case "array":
        return inner(def.element, `${path}[]`, null);
      case "set":
        return inner(def.valueType, `${path}[]`, null);
      case "tuple":
        return [
          ...def.items.flatMap((item, i) => inner(item, `${path}[${i}]`, null)),
          ...(def.rest === null ? [] : inner(def.rest, `${path}[...]`, null)),
        ];
      case "record":
      case "map":
        return [...inner(def.keyType, `${path}{key}`, null), ...inner(def.valueType, `${path}{}`, null)];
      case "union":
        return def.options.flatMap((option) => inner(option));
      case "intersection":
        return [...inner(def.left), ...inner(def.right)];
      case "pipe":
        return [...inner(def.in), ...inner(def.out)];
      case "lazy":
        return inner(def.getter());
      case "optional":
      case "nullable":
      case "default":
      case "prefault":
      case "nonoptional":
      case "catch":
      case "readonly":
      case "promise":
      case "success":
        return inner(def.innerType);
      default:
        return [];
    }
  })();
  return [{ path, name, schema }, ...below];
}

const all = Object.entries(schemas).flatMap(([name, value]) =>
  value instanceof z.core.$ZodType ? places(value, name, null, new Set()) : [],
);
const timestamps = all.filter((p) => p.schema === schemas.Timestamp);

test("the walk finds timestamps through objects, intersections, pipes and tuples", () => {
  const paths = timestamps.map((p) => p.path);
  for (const path of ["Card.createdAt", "Annotation.addedAt", "AnnotationRow.addedAt", "DocumentRow.importedAt", "ReadingKey[0]"])
    assert.ok(paths.includes(path), path);
});

test("a field that holds a Timestamp is at, or named for its event with At", () => {
  const misnamed = timestamps
    .filter((p) => p.name !== null && p.name !== "at" && !p.name.endsWith("At") && !allowed.has(p.path))
    .map((p) => p.path);
  assert.deepEqual(misnamed, []);
});

test("every allowed field is still there", () => {
  const paths = new Set(all.map((p) => p.path));
  for (const path of allowed.keys()) assert.ok(paths.has(path), `${path} is gone; take it out of the allowed list`);
});
