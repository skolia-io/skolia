<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { isLang, type CardGroup, type DocumentId, type Lang } from "@skolia/shared/api";
  import * as schemas from "@skolia/shared/schemas";
  import About from "./pages/About.svelte";
  import Cards from "./pages/Cards.svelte";
  import Explore from "./pages/Explore.svelte";
  import Ingest from "./pages/Ingest.svelte";
  import { userQuery } from "./lib/queries.ts";
  import Button from "./components/Button.svelte";
  import Nav from "./components/Nav.svelte";
  import Reader from "./pages/reader/Reader.svelte";
  import ReadingList from "./pages/ReadingList.svelte";
  import Review from "./pages/Review.svelte";
  import Settings from "./pages/Settings.svelte";
  import Upload from "./pages/Upload.svelte";

  type Route =
    | { page: "explore" }
    | { page: "list" }
    | { page: "upload" }
    | { page: "review"; lang: Lang | null; group: CardGroup | null }
    | { page: "cards"; lang: Lang | null }
    | { page: "settings" }
    | { page: "about" }
    | { page: "ingest" }
    | { page: "reader"; id: DocumentId };

  function parse(hash: string): Route {
    // After the path, a list's filters (lib/filters.ts), which the list reads
    if (/^#\/list(?:\?.*)?$/.test(hash)) return { page: "list" };
    if (hash === "#/upload") return { page: "upload" };
    if (hash === "#/review") return { page: "review", lang: null, group: null };
    const [, review, group] = /^#\/review\/([a-z]+)(?:\/(words|forms))?$/.exec(hash) ?? [];
    if (review !== undefined && isLang(review))
      return { page: "review", lang: review, group: group === "words" || group === "forms" ? group : null };
    if (hash === "#/cards") return { page: "cards", lang: null };
    const [, cards] = /^#\/cards\/([a-z]+)$/.exec(hash) ?? [];
    if (cards !== undefined && isLang(cards)) return { page: "cards", lang: cards };
    if (hash === "#/settings") return { page: "settings" };
    if (hash === "#/about") return { page: "about" };
    if (hash === "#/analysis") return { page: "ingest" };
    // After the id, a word in the text (lib/link.ts), which Reader reads
    const [, doc] = /^#\/doc\/([^?]+)(?:\?.*)?$/.exec(hash) ?? [];
    const id = schemas.DocumentId.safeParse(doc);
    return id.success ? { page: "reader", id: id.data } : { page: "explore" };
  }

  let route = $state(parse(location.hash));
  const signedIn = createQuery(() => userQuery);
  /** undefined while loading, null when signed out. */
  const user = $derived(signedIn.data);
  let error = $state<string | null>(null);

  $effect(() => {
    const failed = signedIn.error;
    if (failed) error = failed.message;
  });
</script>

<svelte:window
  onhashchange={() => {
    // Only a new page is a new route: a new word in the same text (lib/link.ts) is the
    // reader's to follow, and replacing the route would rerun everything that reads it
    const next = parse(location.hash);
    if (JSON.stringify(next) !== JSON.stringify(route)) {
      route = next;
      error = null;
    }
  }}
/>

<!-- A language's review is only its cards, with a way out in its corner -->
{#if !(route.page === "review" && route.lang)}
  <Nav page={route.page} user={user} onerror={(message) => (error = message)} />
{/if}

<div class="content">
  {#if error}
    <div class="banner" role="alert">
      <p>{error}</p>
      <Button variant="icon" aria-label="Dismiss" onclick={() => (error = null)}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
      </Button>
    </div>
  {/if}

  {#if route.page === "reader"}
    {#key route.id}
      <Reader id={route.id} />
    {/key}
  {:else if route.page === "list"}
    <ReadingList user={user} />
  {:else if route.page === "upload"}
    <Upload user={user} />
  {:else if route.page === "review"}
    <!-- Anew, so the languages' counts are loaded again after a session -->
    {#key route.lang}
      <Review user={user} lang={route.lang} group={route.group} />
    {/key}
  {:else if route.page === "cards"}
    <Cards user={user} lang={route.lang} />
  {:else if route.page === "settings"}
    <Settings user={user} />
  {:else if route.page === "about"}
    <About />
  {:else if route.page === "ingest"}
    <Ingest user={user} />
  {:else}
    <Explore user={user} />
  {/if}
</div>

<style>
  .content {
    flex: 1;
  }

  .banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    max-width: 48rem;
    margin: 0.75rem auto 0;
    padding: 0 var(--gutter);
    color: var(--error);
  }

  .banner p {
    margin: 0;
  }
</style>
