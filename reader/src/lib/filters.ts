// A list's filters, kept in the query of its link so back, forward and reload find the list
// as it was left: #/?q=pan&lang=pl&mine=1&tag=level:A1&tag=level:B1 for Explore,
// #/list?lang=pl for the reading list. Only what differs from the defaults is written.
import { isLang, parseTag, type Lang } from "@skolia/shared/api";

export type ExploreFilters = {
  readonly title: string;
  readonly lang: Lang | null;
  readonly mine: boolean;
  /** As kind:value. */
  readonly tags: readonly string[];
};

/** The query of a hash, the part after its "?". */
export const hashQuery = (hash: string): URLSearchParams => new URLSearchParams(hash.split("?")[1] ?? "");

const lang = (query: URLSearchParams): Lang | null => {
  const value = query.get("lang");
  return isLang(value) ? value : null;
};

export function readExplore(query: URLSearchParams): ExploreFilters {
  return {
    title: query.get("q") ?? "",
    lang: lang(query),
    mine: query.get("mine") === "1",
    tags: [...new Set(query.getAll("tag").filter((tag) => parseTag(tag) !== null))],
  };
}

export function writeExplore(filters: ExploreFilters): string {
  return write([
    ...(filters.title.trim() === "" ? [] : [["q", filters.title] as const]),
    ...(filters.lang ? [["lang", filters.lang] as const] : []),
    ...(filters.mine ? [["mine", "1"] as const] : []),
    ...filters.tags.map((tag) => ["tag", tag] as const),
  ]);
}

export const readReadingList = (query: URLSearchParams): Lang | null => lang(query);

export const writeReadingList = (filter: Lang | null): string => write(filter ? [["lang", filter]] : []);

/** The query part of a link, with its "?", or "" for none. */
function write(entries: readonly (readonly [string, string])[]): string {
  const query = new URLSearchParams(entries.map(([k, v]) => [k, v])).toString();
  return query === "" ? "" : `?${query}`;
}

/** Puts the filters in the page's link in place, without a new history entry or a hashchange. */
export function replaceQuery(path: "#/" | "#/list", query: string): void {
  const hash = `${path}${query}`;
  if (location.hash !== hash && !(location.hash === "" && hash === "#/")) history.replaceState(history.state, "", hash);
}
