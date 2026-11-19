// Writes a work from Wolne Lektury, by the slug in its catalogue URL
// (wolnelektury.pl/katalog/lektura/<slug>/), as an inline curated file: its title, author,
// licence, catalogue page and text, with the tags given. --title replaces Wolne Lektury's.
// usage: node api/src/vendor-wolnelektury.ts <slug> <curated/pl/name.yaml> [--title <title>] [--tag <kind:value>]...
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import * as z from "zod";
import { LICENCES, type Licence, type Tags } from "@skolia/shared/api";
import * as schemas from "@skolia/shared/schemas";
import { runScript, scriptLog } from "./script-log.ts";

const log = scriptLog("vendor-wolnelektury");

const WOLNE_LEKTURY_API = "https://wolnelektury.pl/api/books/";

const Book = z.object({
  title: z.string(),
  /** ISO 639-2: pol */
  language: z.string(),
  /** The catalogue page */
  url: z.url(),
  txt: z.url(),
  authors: z.array(z.object({ name: z.string() })),
});

/** What an inline curated file has (curated-kinds.ts), without annotations. */
export type Vendored = {
  readonly title: string;
  readonly author?: string | undefined;
  readonly licence: Licence;
  readonly source: string;
  readonly tags: Tags;
  readonly text: string;
};

const FOOTER = "\n-----\n";

/** An ISBN line, which ends a header with any number of blank lines after it. */
const ISBN_LINE = /^ISBN [0-9X-]+\n/mu;

/** The work in a Wolne Lektury .txt: after its header (author and title, which may wrap,
 * then an ISBN line or three blank lines) and before its footer ("-----"), without the line
 * indents and *emphasis* the .txt keeps. */
export function wolneLekturyText(raw: string): string {
  const body = raw.split(FOOTER)[0] ?? "";
  const blank = body.indexOf("\n\n\n\n");
  const isbn = ISBN_LINE.exec(body);
  const start = isbn && (blank < 0 || isbn.index < blank) ? isbn.index + isbn[0].length : blank;
  if (start < 0) throw new Error("no blank lines after the header");
  return body
    .slice(start)
    .split("\n")
    .map((line) => line.trim().replace(/\*([^*\n]+)\*/gu, "$1"))
    .join("\n")
    .trim();
}

/** The work's licence, from the footer of a Wolne Lektury .txt. */
export function wolneLekturyLicence(raw: string): Licence {
  const footer = raw.split(FOOTER)[1];
  if (footer === undefined) throw new Error('no "-----" footer');
  if (footer.includes("Ten utwór jest w domenie publicznej.")) return "public-domain";
  const cc = /creativecommons\.org\/licenses\/([a-z-]+)\/(\d\.\d)\//u.exec(footer);
  const licence = LICENCES.find((l) => cc !== null && l === `cc-${cc[1]}-${cc[2]}`);
  if (licence !== undefined) return licence;
  throw new Error("the footer names no licence skolia knows");
}

/** The inline curated file's YAML, the text a literal block with its span markup escaped. */
export function inlineYaml({ title, author, licence, source, tags, text }: Vendored): string {
  const escaped = text.replace(/[[\]\\]/gu, (c) => `\\${c}`);
  const file = {
    kind: "inline",
    title,
    ...(author === undefined ? {} : { author }),
    licence,
    source,
    ...(Object.keys(tags).length === 0 ? {} : { tags }),
    text: escaped,
  };
  return stringify(file, { blockQuote: "literal", lineWidth: 0 });
}

async function fetched(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response;
}

/** The work Wolne Lektury has at slug, in Polish. */
export async function vendor(slug: string, tags: Tags, title?: string): Promise<Vendored> {
  const book = Book.parse(await (await fetched(`${WOLNE_LEKTURY_API}${slug}/`)).json());
  if (book.language !== "pol") throw new Error(`${slug} is in ${book.language}, not pol`);
  const raw = (await (await fetched(book.txt)).text()).replace(/\r\n/gu, "\n");
  const author = book.authors.map((a) => a.name).join(", ");
  return {
    title: title ?? book.title,
    ...(author === "" ? {} : { author }),
    licence: wolneLekturyLicence(raw),
    source: book.url,
    tags,
    text: wolneLekturyText(raw),
  };
}

async function main(): Promise<void> {
  const args = parseArgs({
    allowPositionals: true,
    options: { title: { type: "string" }, tag: { type: "string", multiple: true, default: [] } },
  });
  const [slug, path, ...rest] = args.positionals;
  if (slug === undefined || path === undefined || rest.length > 0 || !/^[a-z0-9-]+$/u.test(slug)) {
    process.stderr.write(
      "usage: node api/src/vendor-wolnelektury.ts <slug> <curated/pl/name.yaml> [--title <title>] [--tag <kind:value>]...\n",
    );
    process.exitCode = 2;
    return;
  }
  const tags = schemas.Tags.parse(
    Object.fromEntries(
      args.values.tag.map((tag) => {
        const [kind, value] = tag.split(":", 2);
        if (!kind || !value) throw new Error(`--tag ${tag}: not kind:value`);
        return [kind, value];
      }),
    ),
  );
  const vendored = await vendor(slug, tags, args.values.title);
  await writeFile(path, inlineYaml(vendored));
  log.info("vendored {slug} to {path}", { slug, path, title: vendored.title, licence: vendored.licence });
}

if (import.meta.main) await runScript(log, main);
