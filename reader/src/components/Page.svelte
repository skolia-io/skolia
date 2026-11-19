<script lang="ts">
  import type { Snippet } from "svelte";

  /** A page's column. Its title is for screen readers, since the nav already says where you are;
   * actions sit at the column's top end, wrapping on a phone. */
  let {
    title,
    wide = false,
    ownHeading = false,
    actions,
    children,
  }: { title: string; wide?: boolean; ownHeading?: boolean; actions?: Snippet; children: Snippet } = $props();
</script>

<main class={{ wide }}>
  {#if !ownHeading}
    <h1>{title}</h1>
  {/if}
  {#if actions}
    <div class="actions"> {@render actions()} </div>
  {/if}
  {@render children()}
</main>

<style>
  main {
    max-width: 48rem;
    margin: 0 auto;
    padding: var(--gutter);
  }

  .wide {
    max-width: 56rem;
  }

  h1 {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem 1rem;
    margin: 0.5rem 0 1rem;
  }
</style>
