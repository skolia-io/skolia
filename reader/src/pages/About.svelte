<script lang="ts">
  import Page from "../components/Page.svelte";
  import { versionUrl } from "../lib/version.ts";

  const version = import.meta.env.VITE_VERSION ?? "dev";
  const versionLink = versionUrl(version);
</script>

<Page title="About">
  <p>Skolia is a reader for learning languages: read a text, look up its words, and review them as flashcards.</p>
  <dl>
    <dt>Version</dt>
    <dd>
      {#if versionLink}
        <a href={versionLink} rel="noreferrer">{version}</a>
      {:else}
        {version}
      {/if}
    </dd>
    <dt>Source</dt>
    <dd><a href="https://github.com/skolia-io/skolia" rel="noreferrer">github.com/skolia-io/skolia</a></dd>
  </dl>
</Page>

<style>
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.5rem 1.5rem;
  }

  dt {
    color: var(--muted);
  }

  dd {
    margin: 0;
  }
</style>
