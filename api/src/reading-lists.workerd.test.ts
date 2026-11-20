import assert from "node:assert/strict";
import { test } from "node:test";
import type { DocumentId, ReadingKey } from "@skolia/shared/api";
import type { Cursor } from "@skolia/shared/page";
import { ALICE, client, local, setup, useLocal, walk, importer, raw } from "./testing/app.ts";
import { body, expectStatus } from "@skolia/util/responses";

useLocal();

test("custom lists can be created, renamed, browsed, removed and independently contain the same text", async () => {
  const app = setup();
  const lists = client(app, importer).me["reading-lists"];
  const make = async (name: string) => (await body("create list", lists.$post({ json: { name } }))).id;
  const first = await make("  French stories  ");
  const second = await make("Book club");
  const id = (
    await body(
      "import",
      client(app, importer).documents.$post({ json: { text: "Bonjour le monde.", lang: "fr", visibility: "private", licence: "unknown" } }),
      202,
    )
  ).id;
  const text = lists[":listId"].documents[":id"];
  for (const listId of [first, second, 1]) {
    const param = { listId: String(listId), id };
    await expectStatus("save", text.$put({ param }), 204);
    await expectStatus("save twice", text.$put({ param }), 204);
  }
  assert.deepEqual(
    new Set((await body("memberships", client(app, importer).me["reading-list-memberships"][":id"].$get({ param: { id } }))).lists),
    new Set([first, second, 1]),
  );
  assert.equal((await body("all", lists.$get())).lists.find((list) => list.id === first)?.name, "French stories");
  assert.equal((await body("all", lists.$get())).lists.find((list) => list.id === first)?.documentsCount, 1);
  const firstParam = { listId: String(first) };
  const secondParam = { listId: String(second) };
  await expectStatus("rename", lists[":listId"].$patch({ param: firstParam, json: { name: "Short stories" } }), 204);
  const page = await body("texts", lists[":listId"].documents.$get({ param: firstParam, query: { lang: "fr" } }));
  assert.deepEqual(
    page.items.map((item) => item.document.id),
    [id],
  );
  assert.equal((await body("language", lists[":listId"].documents.$get({ param: firstParam, query: { lang: "pl" } }))).items.length, 0);
  await expectStatus("remove", text.$delete({ param: { ...firstParam, id } }), 204);
  await expectStatus("remove twice", text.$delete({ param: { ...firstParam, id } }), 204);
  assert.equal((await body("all", lists.$get())).lists.find((list) => list.id === first)?.documentsCount, 0);
  await expectStatus("delete list", lists[":listId"].$delete({ param: secondParam }), 204);
  const memberships = () => body("memberships", client(app, importer).me["reading-list-memberships"][":id"].$get({ param: { id } }));
  assert.deepEqual((await memberships()).lists, [1]);
  assert.equal((await lists[":listId"].documents.$get({ param: secondParam, query: {} })).status, 404);
  const seeded = { listId: "1" };
  await expectStatus("rename seeded list", lists[":listId"].$patch({ param: seeded, json: { name: "Later" } }), 204);
  const renamed = (await body("all", lists.$get())).lists.find((list) => list.id === 1);
  assert.equal(renamed?.name, "Later");
  assert.equal(renamed?.documentsCount, 1);
  await expectStatus("delete seeded list", lists[":listId"].$delete({ param: seeded }), 204);
  assert.deepEqual((await memberships()).lists, []);
});

test("lists are private to their user and only visible texts can be added", async () => {
  const app = setup();
  const alice = await local.signIn((await local.signUp(ALICE)).id);
  const own = client(app, importer).me["reading-lists"];
  const theirs = client(app, alice).me["reading-lists"];
  const ownId = (await body("create", own.$post({ json: { name: "Private list" } }))).id;
  const listId = String(ownId);
  assert.ok(!(await body("alice's lists", theirs.$get())).lists.some((list) => list.id === ownId));
  assert.equal((await theirs[":listId"].$patch({ param: { listId }, json: { name: "Stolen" } })).status, 404);
  assert.equal((await theirs[":listId"].$delete({ param: { listId } })).status, 404);
  assert.equal((await theirs[":listId"].documents.$get({ param: { listId }, query: {} })).status, 404);
  const id = (
    await body(
      "import",
      client(app, alice).documents.$post({
        json: { text: "Prywatny tekst listy.", lang: "pl", visibility: "private", licence: "unknown" },
      }),
      202,
    )
  ).id;
  assert.equal((await own[":listId"].documents[":id"].$put({ param: { listId, id } })).status, 404);
  assert.equal((await own[":listId"].documents[":id"].$put({ param: { listId, id: "0".repeat(64) } })).status, 404);
  assert.equal((await theirs[":listId"].documents[":id"].$put({ param: { listId, id } })).status, 404);
  await expectStatus("save own", theirs[":listId"].documents[":id"].$put({ param: { listId: "1", id } }), 204);
  await expectStatus("delete document", client(app, alice).documents[":id"].$delete({ param: { id } }), 204);
  assert.deepEqual(
    (await body("unavailable text hidden", theirs[":listId"].documents.$get({ param: { listId: "1" }, query: {} }))).items,
    [],
  );
  await expectStatus("can still remove", theirs[":listId"].documents[":id"].$delete({ param: { listId: "1", id } }), 204);
});

test("list texts paginate with ties and idempotent saves preserve their place", async () => {
  const app = setup();
  const lists = client(app, importer).me["reading-lists"];
  const listId = String((await body("create", lists.$post({ json: { name: "Pages" } }))).id);
  const ids: DocumentId[] = [];
  for (const text of ["Un.", "Deux.", "Trois."]) {
    const id = (
      await body(
        "import",
        client(app, importer).documents.$post({ json: { text, lang: "fr", visibility: "private", licence: "unknown" } }),
        202,
      )
    ).id;
    ids.push(id);
    await expectStatus("save", lists[":listId"].documents[":id"].$put({ param: { listId, id } }), 204);
  }
  const later = client(setup({ at: "2026-11-05T00:00:00.000Z" }), importer).me["reading-lists"];
  await expectStatus("save again", later[":listId"].documents[":id"].$put({ param: { listId, id: ids[0]! } }), 204);
  const items = await walk(2, (after?: Cursor<ReadingKey>) =>
    body("page", lists[":listId"].documents.$get({ param: { listId }, query: { limit: "2", after } })),
  );
  assert.deepEqual(
    items.map((item) => item.document.id),
    ids.toSorted().reverse(),
  );
});

test("lists validate names and identifiers and require authentication", async () => {
  const app = setup();
  const lists = client(app, importer).me["reading-lists"];
  assert.equal((await client(app).me["reading-lists"].$get()).status, 401);
  assert.equal((await client(app).me["reading-lists"].$post({ json: { name: "List" } })).status, 401);
  for (const name of ["", "   ", "x".repeat(101)]) assert.equal((await lists.$post({ json: { name } })).status, 400);
  for (const listId of ["bad", "0", "-1", "1.5", "1e0", "9007199254740992"]) {
    assert.equal((await lists[":listId"].$delete({ param: { listId } })).status, 400);
  }
  assert.equal((await raw(app, "GET", "/api/me/reading-lists/1/documents?lang=xx", importer, undefined)).status, 400);
});
