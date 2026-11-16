import assert from "node:assert/strict";
import { test } from "node:test";
import { hashQuery, readExplore, readReadingList, writeExplore, writeReadingList, type ExploreFilters } from "./filters.ts";

const NONE: ExploreFilters = { title: "", lang: null, mine: false, tags: [] };

test("filters write only what differs from the defaults", () => {
  assert.equal(writeExplore(NONE), "");
  assert.equal(writeExplore({ ...NONE, title: "  " }), "");
  assert.equal(
    writeExplore({ title: "pan", lang: "pl", mine: true, tags: ["level:A1", "level:B1"] }),
    "?q=pan&lang=pl&mine=1&tag=level%3AA1&tag=level%3AB1",
  );
  assert.equal(writeReadingList(null), "");
  assert.equal(writeReadingList("pl"), "?lang=pl");
});

test("filters read back as they were written", () => {
  const filters: ExploreFilters[] = [NONE, { title: "pan tadeusz & co", lang: "pl", mine: true, tags: ["level:B1"] }];
  for (const f of filters) assert.deepEqual(readExplore(hashQuery(`#/${writeExplore(f)}`)), f);
  assert.equal(readReadingList(hashQuery(`#/list${writeReadingList("pl")}`)), "pl");
});

test("filters that aren't ones are dropped", () => {
  assert.deepEqual(readExplore(hashQuery("#/?lang=xx&mine=yes&tag=level&tag=level:B1&tag=level:B1")), { ...NONE, tags: ["level:B1"] });
  assert.deepEqual(readExplore(hashQuery("")), NONE);
  assert.equal(readReadingList(hashQuery("#/list?lang=")), null);
});
