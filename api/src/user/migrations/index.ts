import * as initial from "./0001_initial.ts";

export interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
}

export const MIGRATIONS: readonly Migration[] = [{ version: 1, name: "initial", ...initial }];
