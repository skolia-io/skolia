<script lang="ts">
  let { name, count }: { name: string; count?: number } = $props();
  const tone = $derived(Array.from(name).reduce((hash, ch) => (hash * 31 + ch.codePointAt(0)!) >>> 0, 0) % 5);
</script>

<div class="cover" data-tone={tone} aria-hidden="true">
  <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 12h32M8 20h32M8 28h20M8 36h20m11-8v12m-6-6h12" />
  </svg>
  {#if count !== undefined}
    <span>{count.toLocaleString()} {count === 1 ? "text" : "texts"}</span>
  {/if}
</div>

<style>
  .cover {
    --ink: #c8dff7;
    --start: #203b5a;
    --end: #345d85;
    position: relative;
    display: grid;
    place-items: center;
    aspect-ratio: 16 / 9;
    border-radius: 12px;
    overflow: hidden;
    isolation: isolate;
    color: var(--ink);
    background: radial-gradient(ellipse at 80% 10%, var(--end), transparent 85%), var(--start);
  }
  [data-tone="1"] {
    --ink: #f2d7cb;
    --start: #58362c;
    --end: #865541;
  }
  [data-tone="2"] {
    --ink: #ddd5f6;
    --start: #3e3458;
    --end: #65527e;
  }
  [data-tone="3"] {
    --ink: #c8e6d8;
    --start: #243f36;
    --end: #386957;
  }
  [data-tone="4"] {
    --ink: #f3deb6;
    --start: #4e3922;
    --end: #765b33;
  }
  .cover::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    background: repeating-linear-gradient(135deg, transparent 0 16px, rgb(255 255 255 / 0.045) 16px 17px);
    mask-image: linear-gradient(135deg, transparent 25%, black);
  }
  svg {
    width: 27%;
    max-width: 3.5rem;
  }
  span {
    position: absolute;
    inset: auto 0.45rem 0.45rem auto;
    padding: 0.2rem 0.45rem;
    border-radius: 4px;
    background: rgb(0 0 0 / 0.55);
    color: white;
    font-size: 0.75rem;
    font-weight: 600;
  }
</style>
