import type { Identity } from "@skolia/shared/api";

export interface Auth {
  handle(request: Request): Promise<Response>;
  user(headers: Headers): Promise<Identity | null>;
}
