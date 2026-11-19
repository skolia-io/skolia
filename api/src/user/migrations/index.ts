import * as initial from "./0001_initial.ts";
import * as readingLists from "./0002_reading_lists.ts";
import * as readingListDocuments from "./0003_reading_list_documents.ts";

export interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "initial", ...initial },
  { version: 2, name: "reading_lists", ...readingLists },
  { version: 3, name: "reading_list_documents", ...readingListDocuments },
];
