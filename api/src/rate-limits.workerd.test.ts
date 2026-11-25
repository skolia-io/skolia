import assert from "node:assert/strict";
import { test } from "node:test";
import { body, expectStatus } from "@skolia/util/responses";
import { SYSTEM_USER } from "./e2e-keys.ts";
import { NOW, client, importer, local, setup, useLocal } from "./testing/app.ts";
import { D1Roles } from "./worker/adapters/roles.ts";

useLocal();

const TWO_A_MINUTE = { limit: 2, windowSeconds: 60 };

/** NOW, seconds later. */
const after = (seconds: number) => new Date(Date.parse(NOW) + seconds * 1000).toISOString();

const importAt = (at: string, headers: Headers, text: string) =>
  client(setup({ at, importRate: TWO_A_MINUTE }), headers).documents.$post({ json: { text, lang: "pl" } });

test("imports past the limit get 429 with Retry-After until the window ends", async () => {
  await body("first", importAt(NOW, importer, "Pierwszy tekst."), 202);
  await body("second", importAt(after(10), importer, "Drugi tekst."), 202);
  const refused = await expectStatus("third", importAt(after(15), importer, "Trzeci tekst."), 429);
  assert.equal(refused.headers.get("retry-after"), "45");
  assert.deepEqual(await refused.json(), {
    error: { code: "rate-limited", action: "import", limit: 2, windowSeconds: 60, retryAfterSeconds: 45 },
  });
  // A refused import doesn't count, and doesn't import
  assert.equal((await expectStatus("still", importAt(after(59), importer, "Trzeci tekst."), 429)).headers.get("retry-after"), "1");
  assert.equal(local.started.length, 2);
  await body("next window", importAt(after(60), importer, "Trzeci tekst."), 202);
  await body("then one more", importAt(after(61), importer, "Czwarty tekst."), 202);
  await expectStatus("and the limit again", importAt(after(62), importer, "Piąty tekst."), 429);
});

test("each user has their own window", async () => {
  const other = await local.signIn((await local.signUp({ name: "Olek", email: "olek@example.com" })).id);
  await body("first", importAt(NOW, importer, "Pierwszy tekst."), 202);
  await body("second", importAt(NOW, importer, "Drugi tekst."), 202);
  await expectStatus("third", importAt(NOW, importer, "Trzeci tekst."), 429);
  await body("someone else", importAt(NOW, other, "Trzeci tekst."), 202);
});

test("a user bound to a role that grants unlimited-rate isn't limited, and one bound to none is", async () => {
  const user = await local.signUp({ name: "Olek", email: "olek@example.com" });
  const headers = await local.signIn(user.id);
  const db = local.env.DB;
  await db.prepare("INSERT INTO role_binding (user_id, role) VALUES (?, 'system')").bind(user.id).run();
  const texts = ["Pierwszy tekst.", "Drugi tekst.", "Trzeci tekst."];
  for (const text of texts) await body(text, importAt(NOW, headers, text), 202);
  await db.prepare("DELETE FROM role_binding WHERE user_id = ?").bind(user.id).run();
  await body("counted now", importAt(NOW, headers, "Czwarty tekst."), 202);
  await body("counted now", importAt(NOW, headers, "Piąty tekst."), 202);
  await expectStatus("limited without a binding", importAt(NOW, headers, "Szósty tekst."), 429);
});

test("a user's permissions are those of all their roles", async () => {
  const user = await local.signUp({ name: "Olek", email: "olek@example.com" });
  const db = local.env.DB;
  await db.batch([
    db.prepare("INSERT INTO role (name) VALUES ('reader'), ('helper')"),
    db.prepare("INSERT INTO permission (name, description) VALUES ('future', 'Something new')"),
    db.prepare("INSERT INTO role_permission (role, permission) VALUES ('reader', 'future'), ('helper', 'unlimited-rate')"),
    db.prepare("INSERT INTO role_binding (user_id, role) VALUES (?, 'reader'), (?, 'helper')").bind(user.id, user.id),
  ]);
  try {
    const roles = new D1Roles(db);
    assert.ok(await roles.grants(user.id, "unlimited-rate"));
    const reader = await local.signUp({ name: "Ola", email: "ola@example.com" });
    await db.prepare("INSERT INTO role_binding (user_id, role) VALUES (?, 'reader')").bind(reader.id).run();
    assert.equal(await roles.grants(reader.id, "unlimited-rate"), false);
  } finally {
    await db.batch([
      db.prepare("DELETE FROM role_binding WHERE role IN ('reader', 'helper')"),
      db.prepare("DELETE FROM role_permission WHERE role IN ('reader', 'helper')"),
      db.prepare("DELETE FROM permission WHERE name = 'future'"),
      db.prepare("DELETE FROM role WHERE name IN ('reader', 'helper')"),
    ]);
  }
});

test("the system role isn't limited, by its grant rather than its name", async () => {
  const system = await local.signIn(SYSTEM_USER);
  const texts = ["Pierwszy tekst.", "Drugi tekst.", "Trzeci tekst.", "Czwarty tekst."];
  for (const text of texts) await body(text, importAt(NOW, system, text), 202);
  const grant = local.env.DB.prepare("DELETE FROM role_permission WHERE role = 'system' AND permission = 'unlimited-rate'");
  await grant.run();
  try {
    await body("counted now", importAt(NOW, system, "Piąty tekst."), 202);
    await body("counted now", importAt(NOW, system, "Szósty tekst."), 202);
    await expectStatus("limited without it", importAt(NOW, system, "Siódmy tekst."), 429);
  } finally {
    await local.env.DB.prepare("INSERT INTO role_permission (role, permission) VALUES ('system', 'unlimited-rate')").run();
  }
});
