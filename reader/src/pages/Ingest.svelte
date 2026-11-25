<script lang="ts">
  import { describeIngestFailure } from "../lib/ingest-failures.ts";
  import { createQuery } from "@tanstack/svelte-query";
  import { LANGUAGE_INFO, type IngestedDocument, type StageTime, type User } from "@skolia/shared/api";
  import Button from "../components/Button.svelte";
  import Page from "../components/Page.svelte";
  import { signIn } from "../lib/api.ts";
  import { OUTCOME_LABELS, STAGE_LABELS, ago, between, duration, liveStatus } from "../lib/ingest.ts";
  import { ingestQuery } from "../lib/queries.ts";

  let { user }: { user: User | null | undefined } = $props();

  const ingest = createQuery(() => ({ ...ingestQuery, enabled: !!user }));

  let now = $state(new Date());
  $effect(() => {
    const timer = setInterval(() => (now = new Date()), 1000);
    return () => clearInterval(timer);
  });

  const words = (count: number) => `${count.toLocaleString("en")} ${count === 1 ? "word" : "words"}`;
</script>

{#snippet title(document: IngestedDocument)}
  {#if document}
    <span class="title">{document.title || "Untitled"}</span>
  {:else}
    <span class="title private">A private text</span>
  {/if}
{/snippet}

{#snippet stages(times: readonly StageTime[])}
  {@const longest = Math.max(1, ...times.map(({ ms }) => ms))}
  <dl class="stages">
    {#each times as { stage, ms }, i (i)}
      <dt>{STAGE_LABELS[stage]}</dt>
      <dd class="track"><span class="bar" style:width="{(ms / longest) * 100}%"></span></dd>
      <dd class="ms">{duration(ms)}</dd>
    {/each}
  </dl>
{/snippet}

<Page title="Analysis">
  {#if user === null}
    <p class="muted">Sign in to see what analysis is doing.</p>
    <Button variant="primary" onclick={() => void signIn()}>Sign in</Button>
  {:else if user && ingest.data}
    <div class="sections">
      <section class="card">
        <h2 class="head">Now</h2>
        <ul class="rows">
          {#each ingest.data.languages as { lang, container } (lang)}
            {@const busy = container !== null && container.jobs.length > 0}
            <li class="language">
              <div class="row">
                <span lang={lang}>{LANGUAGE_INFO[lang].flag} {LANGUAGE_INFO[lang].endonym}</span>
                <span class={["state", { active: container !== null }]}>
                  {#if container === null}
                    Idle
                  {:else if container.loading}
                    Starting{container.startedAt ? ` · ${duration(between(container.startedAt, now))}` : ""}
                  {:else if !busy}
                    Waiting for texts
                  {:else}
                    {container.jobs.length} {container.jobs.length === 1 ? "text" : "texts"}
                  {/if}
                </span>
              </div>
              {#if container && busy}
                <ol class="jobs">
                  {#each container.jobs as job (job.id)}
                    <li class="row">
                      {#if job.document}
                        <a class="title" href="#/doc/{job.document.id}">{job.document.title || "Untitled"}</a>
                      {:else}
                        {@render title(null)}
                      {/if}
                      <span class={["state", { active: job.startedAt !== null }]}>{liveStatus(job, now)}</span>
                    </li>
                  {/each}
                </ol>
              {/if}
            </li>
          {/each}
        </ul>
      </section>

      <section class="card">
        <h2 class="head">Recent{ingest.data.recent.length > 0 ? ` · ${ingest.data.recent.length}` : ""}</h2>
        {#if ingest.data.recent.length === 0}
          <p class="empty">Nothing analysed lately.</p>
        {:else}
          <ul class="rows">
            {#each ingest.data.recent as job (job.id)}
              {@const result = job.result}
              <li>
                <details>
                  <summary>
                    <span class="summary-head">
                      {@render title(job.document)}
                      <span class={["badge", result?.outcome ?? "unfinished"]}>
                        {result ? OUTCOME_LABELS[result.outcome] : "Unfinished"}
                      </span>
                    </span>
                    <span class="meta">
                      <span>{LANGUAGE_INFO[job.lang].flag} {LANGUAGE_INFO[job.lang].endonym}</span>
                      {#if result && result.words !== null}
                        <span>{words(result.words)}</span>
                      {/if}
                      {#if result}
                        <span>took {duration(between(job.startedAt, result.finishedAt))}</span>
                      {/if}
                      <span>{result ? ago(result.finishedAt, now) : `started ${ago(job.startedAt, now)}`}</span>
                    </span>
                  </summary>
                  <div class="details">
                    {#if result === null}
                      <p class="muted">No result yet: its container stopped before it finished, or the result is on its way.</p>
                    {:else}
                      {#if result.error}
                        <p class="error">{describeIngestFailure(result.error)}</p>
                      {/if}
                      {@render stages(result.stages)}
                    {/if}
                    <p class="muted foot">
                      Waited {duration(between(job.acceptedAt, job.startedAt))} to start
                      {#if job.document}
                        · <a href="#/doc/{job.document.id}">Open the text</a>
                      {/if}
                    </p>
                  </div>
                </details>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    </div>
  {:else if ingest.error}
    <p class="error">{ingest.error.message}</p>
  {/if}
</Page>

<style>
  .sections {
    display: grid;
    gap: 1.25rem;
  }

  .card {
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--surface);
    box-shadow: var(--card-shadow);
    overflow: hidden;
  }

  .head {
    margin: 0;
    padding: 0.4rem 1rem;
    border-bottom: 1px solid var(--line);
    background: var(--bg);
    font-size: 0.9rem;
    font-weight: 600;
  }

  ul,
  ol {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .rows > li + li {
    border-top: 1px solid var(--line);
  }

  .language {
    padding: 0.75rem 1rem;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.25rem 1rem;
  }

  .jobs {
    display: grid;
    gap: 0.4rem;
    margin-top: 0.6rem;
    padding-left: 0.75rem;
    border-left: 2px solid var(--line);
  }

  .title {
    min-width: 0;
    font-family: var(--reading);
    font-size: 1.05rem;
    font-weight: 600;
    line-height: 1.3;
    overflow-wrap: anywhere;
  }

  a.title {
    color: inherit;
    text-decoration: none;
  }

  a.title:hover {
    color: var(--accent);
  }

  .title.private {
    color: var(--muted);
    font-style: italic;
    font-weight: normal;
  }

  .state {
    color: var(--muted);
    font-size: 0.9rem;
    font-variant-numeric: tabular-nums;
  }

  .state.active {
    color: var(--accent);
  }

  summary {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.3rem 1rem;
    padding: 0.75rem 1rem;
    cursor: pointer;
    list-style: none;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary::after {
    content: "";
    grid-column: 2;
    grid-row: 1 / span 2;
    align-self: center;
    width: 1rem;
    height: 1rem;
    background: var(--chevron) center / contain no-repeat;
    transition: rotate 0.15s;
  }

  details[open] summary::after {
    rotate: 180deg;
  }

  summary:hover {
    background: var(--bg);
  }

  summary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .summary-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem 0.6rem;
  }

  .badge {
    padding: 0.05rem 0.45rem;
    border-radius: 99px;
    background: var(--line);
    color: var(--muted);
    font-size: 0.8rem;
  }

  .badge.failed {
    background: color-mix(in srgb, var(--error) 15%, transparent);
    color: var(--error);
  }

  .badge.unfinished {
    background: none;
    border: 1px solid var(--line);
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.15rem 0.45rem;
    color: var(--muted);
    font-size: 0.8rem;
  }

  .meta > span:not(:last-child)::after {
    content: "·";
    margin-left: 0.45rem;
  }

  .details {
    padding: 0.5rem 1rem 0.9rem;
  }

  .details p {
    margin: 0 0 0.5rem;
    font-size: 0.875rem;
  }

  .details .foot {
    margin: 0.75rem 0 0;
    font-size: 0.8rem;
  }

  .stages {
    display: grid;
    grid-template-columns: max-content 1fr auto;
    align-items: center;
    gap: 0.3rem 0.75rem;
    margin: 0;
    font-size: 0.8rem;
  }

  .stages dt {
    color: var(--muted);
  }

  .stages dd {
    margin: 0;
  }

  .track {
    height: 0.4rem;
    border-radius: 99px;
    background: var(--bg);
  }

  .bar {
    display: block;
    height: 100%;
    min-width: 0.4rem;
    border-radius: 99px;
    background: var(--accent);
    opacity: 0.7;
  }

  .ms {
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .empty {
    margin: 0;
    padding: 2rem 1rem;
    color: var(--muted);
    text-align: center;
  }

  .muted {
    color: var(--muted);
  }

  .error {
    color: var(--error);
    overflow-wrap: anywhere;
  }
</style>
