<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { LANGUAGE_INFO, type IngestedDocument, type StageTime } from "@skolia/shared/api";
  import Page from "../components/Page.svelte";
  import { OUTCOME_LABELS, STAGE_LABELS, ago, between, duration, liveStatus } from "../lib/ingest.ts";
  import { ingestQuery } from "../lib/queries.ts";

  const ingest = createQuery(() => ingestQuery);

  let now = $state(new Date());
  $effect(() => {
    const timer = setInterval(() => (now = new Date()), 1000);
    return () => clearInterval(timer);
  });

  const words = (count: number | null) => (count === null ? null : `${count.toLocaleString("en")} words`);
</script>

{#snippet text(document: IngestedDocument)}
  {#if document}
    <a href="#/doc/{document.id}">{document.title || "Untitled"}</a>
  {:else}
    <span class="muted">A private text</span>
  {/if}
{/snippet}

{#snippet stages(times: readonly StageTime[])}
  {@const longest = Math.max(1, ...times.map(({ ms }) => ms))}
  <dl class="stages">
    {#each times as { stage, ms }, i (i)}
      <dt>{STAGE_LABELS[stage]}</dt>
      <dd>
        <span class="track"><span class="bar" style:width="{(ms / longest) * 100}%"></span></span>
        <span class="ms">{duration(ms)}</span>
      </dd>
    {/each}
  </dl>
{/snippet}

<Page title="Analysis">
  {#if ingest.data}
    <section>
      <h2>Now</h2>
      <ul class="languages">
        {#each ingest.data.languages as { lang, container } (lang)}
          <li>
            <div class="lang">
              <span {lang}>{LANGUAGE_INFO[lang].flag} {LANGUAGE_INFO[lang].endonym}</span>
              <span class="muted">
                {#if container === null}
                  Idle
                {:else if container.loading}
                  Starting{container.startedAt ? ` · ${duration(between(container.startedAt, now))}` : ""}
                {:else if container.jobs.length === 0}
                  Waiting for texts
                {:else}
                  {container.jobs.length} {container.jobs.length === 1 ? "text" : "texts"}
                {/if}
              </span>
            </div>
            {#if container && container.jobs.length > 0}
              <ol class="jobs">
                {#each container.jobs as job (job.id)}
                  <li>
                    <div class="line">
                      {@render text(job.document)}
                      <span class="muted">{liveStatus(job, now)}</span>
                    </div>
                    {#if job.stages.length > 0}
                      {@render stages(job.stages)}
                    {/if}
                  </li>
                {/each}
              </ol>
            {/if}
          </li>
        {/each}
      </ul>
    </section>

    <section>
      <h2>Recent</h2>
      {#if ingest.data.recent.length === 0}
        <p class="muted">Nothing analysed lately.</p>
      {:else}
        <ul class="recent">
          {#each ingest.data.recent as job (job.id)}
            {@const result = job.result}
            <li>
              <div class="line">
                {@render text(job.document)}
                {#if result}
                  <span class={["outcome", result.outcome]}>{OUTCOME_LABELS[result.outcome]}</span>
                {:else}
                  <span class="outcome unfinished">Unfinished</span>
                {/if}
              </div>
              <details>
                <summary class="meta muted">
                  <span>{LANGUAGE_INFO[job.lang].flag}</span>
                  {#if result && words(result.words)}
                    <span>{words(result.words)}</span>
                  {/if}
                  {#if result}
                    <span>took {duration(between(job.startedAt, result.finishedAt))}</span>
                  {/if}
                  <span>waited {duration(between(job.acceptedAt, job.startedAt))}</span>
                  <span>{result ? ago(result.finishedAt, now) : `started ${ago(job.startedAt, now)}`}</span>
                </summary>
                {#if result === null}
                  <p class="muted"
                    >No analyser is running it, and it hasn't sent its result: its container stopped, or the result is on its way.</p
                  >
                {:else}
                  {#if result.error}
                    <p class="error">{result.error}</p>
                  {/if}
                  {@render stages(result.stages)}
                {/if}
                <p class="image muted">{job.image}</p>
              </details>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {:else if ingest.error}
    <p class="error">{ingest.error.message}</p>
  {/if}
</Page>

<style>
  section + section {
    margin-top: 2rem;
  }

  h2 {
    font-size: 1rem;
    margin: 0 0 0.75rem;
  }

  ul,
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .languages > li + li,
  .recent > li + li {
    border-top: 1px solid var(--line);
  }

  .languages > li,
  .recent > li {
    padding: 0.6rem 0;
  }

  .lang,
  .line {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0.25rem 1rem;
  }

  .line > :first-child {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .jobs {
    margin-top: 0.5rem;
    padding-left: 1rem;
    display: grid;
    gap: 0.5rem;
  }

  summary {
    cursor: pointer;
  }

  .meta {
    font-size: 0.875rem;
  }

  .meta > span {
    display: inline-block;
    margin-right: 0.75rem;
  }

  .outcome.failed {
    color: var(--error);
  }

  .outcome.retried,
  .outcome.ready {
    color: var(--muted);
  }

  .stages {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 0.75rem;
    margin: 0.5rem 0 0;
    font-size: 0.875rem;
  }

  .stages dt {
    color: var(--muted);
  }

  .stages dd {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
  }

  .track {
    flex: 1;
    min-width: 0;
  }

  .bar {
    display: block;
    height: 0.4rem;
    min-width: 2px;
    border-radius: 2px;
    background: var(--accent);
    opacity: 0.6;
  }

  .ms {
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .image {
    margin: 0.5rem 0 0;
    font-size: 0.8rem;
    overflow-wrap: anywhere;
  }

  .error {
    color: var(--error);
  }
</style>
