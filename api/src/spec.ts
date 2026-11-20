// The spec api/openapi.json holds, made from the marks on the routes' middleware
// (openapi.ts). just openapi writes it, and openapi.test.ts checks it's current.
// Node only: what it imports turns schemas into JSON Schema, which the Worker doesn't need.
import type { OpenAPIV3_1 } from "openapi-types";
import { specJson } from "@skolia/util/openapi-spec";
import { createApp } from "./app.ts";
import { API_KEY_HEADER } from "./auth.ts";
import { TAGS } from "./openapi.ts";
import type { Deps } from "./ports/index.ts";

const DOCUMENTATION = {
  openapi: "3.1.0",
  info: {
    title: "skolia API",
    version: "unversioned",
    license: { name: "Apache 2.0", identifier: "Apache-2.0" },
    description:
      "The API behind skolia.io's reader. Sign in on the reader, and the requests Scalar's page (/api/scalar) tries " +
      "carry your session cookie. Lists come a page at a time: pass a page's next as ?after= for the page after it. " +
      "Every offset into a text is in UTF-16 code units, a JavaScript string index. The lexicon is its own API, " +
      "served under /api/lexicon/ (its spec at /api/lexicon/v1/openapi.json).",
  },
  servers: [{ url: "/", description: "The deployment serving this spec" }],
  tags: [
    { name: TAGS.account, description: "Who's signed in, and what's deployed" },
    {
      name: TAGS.cards,
      description: "Review cards, which are what the user is learning and knows, their schedule and the user's review settings",
    },
    { name: TAGS.documents, description: "Texts, each user's entry for them, and their analyses" },
    { name: TAGS.annotations, description: "What an entry's user attached to ranges of its text" },
    { name: TAGS.reading, description: "The reading list, and where the user is in each text" },
  ],
  components: {
    securitySchemes: {
      session: { type: "apiKey", in: "cookie", name: "__Secure-better-auth.session_token", description: "Better Auth's session" },
      apiKey: {
        type: "apiKey",
        in: "header",
        name: API_KEY_HEADER,
        description: "Only skolia's own accounts have keys: the end-to-end tests' and the curated texts'",
      },
    },
  },
} as const satisfies Partial<OpenAPIV3_1.Document>;

/** The spec, as JSON has it. Its version is filled in where it's served, with the deploy's.
 * Making it runs no route, so the app needs no deps. */
export async function appSpec(): Promise<unknown> {
  return await specJson(createApp({} as Deps), DOCUMENTATION);
}

if (import.meta.main) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(new URL("../openapi.json", import.meta.url), `${JSON.stringify(await appSpec(), null, 2)}\n`);
}
