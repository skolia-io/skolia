import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCurated, resolveCurated } from "./sync-curated.ts";
import { inlineYaml, wolneLekturyLicence, wolneLekturyText } from "./vendor-wolnelektury.ts";

const FOOTER_PD =
  "\n-----\nTa lektura, podobnie jak tysiące innych, dostępna jest na stronie wolnelektury.pl.\nTen utwór jest w domenie publicznej.\nWszystkie materiały dodatkowe (przypisy, motywy literackie) są udostępnione na Licencji Wolnej Sztuki 1.3: https://artlibre.org/licence/lal/pl/\n";

/** A .txt as Wolne Lektury serves it, its CRLFs made LF: the title wrapped, an indent and *emphasis*. */
const TXT = `Aleksander Fredro\n\nOsiołkowi\nw żłoby dano\n\n\n\nOsiołkowi w żłoby dano\nNagle — *gwizd*!\n\n    Z głodu padła.\n\n\n\n${FOOTER_PD}`;

test("a Wolne Lektury text is the work between its header and footer, without indents or emphasis", () => {
  assert.equal(wolneLekturyText(TXT), "Osiołkowi w żłoby dano\nNagle — gwizd!\n\nZ głodu padła.");
  assert.throws(() => wolneLekturyText("Fredro\nOsiołkowi\n-----\n"), /no blank lines after the header/u);
});

test("a Wolne Lektury header with an ISBN ends at it, however many blank lines follow", () => {
  const work = "Położył się Dyzio na łące\n\n\n\nI marzy";
  assert.equal(wolneLekturyText(`Julian Tuwim\n\nDyzio marzyciel\n\nISBN 978-83-288-7398-8\n\n\n${work}\n-----\n`), work);
  assert.equal(wolneLekturyText(`Julian Tuwim\n\nDyzio marzyciel\n\nISBN 978-83-288-7398-8\n\n\n\n\n${work}\n-----\n`), work);
});

test("a Wolne Lektury licence is read from its footer", () => {
  assert.equal(wolneLekturyLicence(`a\n\n\n\nb${FOOTER_PD}`), "public-domain");
  const cc = (kind: string, version = "3.0") =>
    `a\n\n\n\nb\n-----\nTen utwór jest udostępniony na licencji Creative Commons: https://creativecommons.org/licenses/${kind}/${version}/\n`;
  assert.equal(wolneLekturyLicence(cc("by-sa")), "cc-by-sa-3.0");
  assert.equal(wolneLekturyLicence(cc("by")), "cc-by-3.0");
  assert.equal(wolneLekturyLicence(cc("by-sa", "4.0")), "cc-by-sa-4.0");
  assert.throws(() => wolneLekturyLicence(cc("by-sa", "2.5")), /names no licence/u);
  assert.throws(() => wolneLekturyLicence("a\n\n\n\nb"), /no "-----" footer/u);
});

test("a vendored work is an inline file that imports its text as it was, brackets and backslashes included", async () => {
  const vendored = {
    title: "Osiołkowi w żłoby dano",
    author: "Aleksander Fredro",
    licence: "public-domain",
    source: "https://wolnelektury.pl/katalog/lektura/fredro-osiolkowi-w-zloby-dano/",
    tags: { level: "B1" },
    text: "Osiołkowi [w żłoby] dano\\\n\n  Z głodu padła.",
  } as const;
  const [text] = await resolveCurated([parseCurated("pl/o.yaml", "pl", inlineYaml(vendored))]);
  assert.deepEqual(text?.request, { ...vendored, lang: "pl", visibility: "public" });
  assert.deepEqual(text?.annotations, []);
});
