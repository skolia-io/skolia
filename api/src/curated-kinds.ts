// The kinds of curated file, curated/{lang}/{name}.yaml. Each is checked (CuratedSpec),
// then resolved to a text and its credits.
import * as z from "zod";
import { LICENCES, type Licence, type NewAnnotation, type Tags } from "@skolia/shared/api";
import * as schemas from "@skolia/shared/schemas";
import { LABEL, parseSpans } from "./curated-spans.ts";

/** A curated text, its credits and its annotations, as sync-curated imports them. */
export type Resolved = {
  readonly title: string;
  readonly licence: Licence;
  readonly author?: string | undefined;
  readonly source?: string | undefined;
  readonly tags: Tags;
  readonly text: string;
  readonly annotations: readonly NewAnnotation[];
};

const ATTRIBUTION_FIELDS: readonly string[] = Object.keys(schemas.AnnotationAttribution.shape);
const Annotation = z.intersection(schemas.AnnotationAttribution, schemas.AnnotationContent);

/** An annotation in a curated file: what the API's NewAnnotation takes but where it is,
 * which its span gives, and with its kind's data beside its kind and credit rather than
 * under data (kind: audio, url: …). Errors name the field as the file has it. */
const CuratedAnnotation = z.looseObject({}).transform((item, context): z.output<typeof Annotation> => {
  const fields = Object.entries(item);
  const nested = {
    ...Object.fromEntries(fields.filter(([key]) => key === "kind" || ATTRIBUTION_FIELDS.includes(key))),
    data: Object.fromEntries(fields.filter(([key]) => key !== "kind" && !ATTRIBUTION_FIELDS.includes(key))),
  };
  const parsed = Annotation.safeParse(nested);
  if (parsed.success) return parsed.data;
  for (const issue of parsed.error.issues) {
    const path = issue.path[0] === "data" ? issue.path.slice(1) : issue.path;
    context.addIssue({ code: "custom", message: issue.message.replace(" annotation data ", " annotation "), path: [...path] });
  }
  return z.NEVER;
});

/** The text without its [span]{label} markup (curated-spans.ts), and its spans. */
const MarkedText = z.string().transform((text, context) => {
  try {
    return parseSpans(text);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
    return z.NEVER;
  }
});

/** The text is in the file. annotations: by the label of the span they're on, one or a list. */
const Inline = z
  .strictObject({
    kind: z.literal("inline"),
    title: z.string().min(1),
    licence: z.enum(LICENCES),
    author: z.string().min(1).optional(),
    source: z.string().optional(),
    tags: schemas.Tags.default({}),
    text: MarkedText,
    annotations: z
      .record(
        z.string(),
        z.preprocess((value) => (Array.isArray(value) ? value : [value]), z.array(CuratedAnnotation).min(1)),
      )
      .default({}),
  })
  .superRefine(({ text, annotations }, context) => {
    for (const { label } of text.spans) {
      if (!Object.hasOwn(annotations, label))
        context.addIssue({ code: "custom", path: ["text"], message: `{${label}} has no annotations` });
    }
    const used = new Set(text.spans.map((s) => s.label));
    for (const label of Object.keys(annotations)) {
      const message = LABEL.test(label) ? "no span in the text has this label" : "a label is lowercase letters, digits and hyphens";
      if (!used.has(label)) context.addIssue({ code: "custom", path: ["annotations", label], message });
    }
  });

export const CuratedSpec = z.discriminatedUnion("kind", [Inline]);
export type CuratedSpec = z.output<typeof CuratedSpec>;

/** The text, its credits and its annotations, each where its span is in the text. */
export function resolve(spec: CuratedSpec): Resolved {
  switch (spec.kind) {
    case "inline": {
      const { kind: _, text, annotations, ...credits } = spec;
      return {
        ...credits,
        text: text.text,
        annotations: text.spans.flatMap(({ label, start, end }) => (annotations[label] ?? []).map((a) => ({ ...a, start, end }))),
      };
    }
  }
}
