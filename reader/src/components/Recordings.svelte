<script lang="ts">
  import type { AnnotationId, Lang } from "@skolia/shared/api";
  import type { AudioAnnotation, Clip } from "../lib/annotations.ts";

  /** The text's recordings of a word, or of a phrase it's in, each a row with a play button.
   * word: the word the sheet is for, whose recording needn't say its words again. */
  let {
    clips,
    word,
    lang,
    playing,
    onplay,
  }: {
    clips: readonly Clip[];
    word: string;
    lang: Lang;
    playing: AnnotationId | null;
    onplay: (annotation: AudioAnnotation) => void;
  } = $props();
</script>

{#each clips as { annotation, words } (annotation.id)}
  {@const on = playing === annotation.id}
  {@const label = `${on ? "Pause" : "Play"} “${words}”`}
  <p>
    <span class="muted">Recording</span>
    <button type="button" class={{ on }} aria-label={label} title={label} onclick={() => onplay(annotation)}>
      {#if on}
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.5v9M10.5 3.5v9" /></svg>
      {:else}
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.5v9l7-4.5z" /></svg>
      {/if}
    </button>
    {#if words !== word}
      <span lang={lang}>{words}</span>
    {/if}
  </p>
{/each}

<style>
  p {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0.2rem 0;
  }

  .muted {
    color: var(--muted);
    font-size: 0.9rem;
  }

  button {
    position: relative;
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 50%;
    background: var(--surface);
    color: var(--accent);
    cursor: pointer;
  }

  /* Big enough to tap */
  button::after {
    content: "";
    position: absolute;
    inset: -0.5rem;
  }

  button:hover {
    border-color: var(--accent);
  }

  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  button.on {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--bg);
  }

  svg {
    width: 0.75rem;
    height: 0.75rem;
    fill: currentColor;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
</style>
