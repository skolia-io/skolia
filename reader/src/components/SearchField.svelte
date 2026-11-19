<script lang="ts">
  let { value = $bindable(), label }: { value: string; label: string } = $props();
</script>

<label class="search">
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4.5 4.5" />
  </svg>
  <input type="search" bind:value placeholder={label} aria-label={label}>
</label>

<style>
  .search {
    position: relative;
    display: block;
    margin-bottom: 1rem;
  }
  svg {
    position: absolute;
    left: 0.85rem;
    top: 50%;
    width: 1.1rem;
    height: 1.1rem;
    translate: 0 -50%;
    fill: none;
    stroke: var(--muted);
    stroke-width: 1.8;
    stroke-linecap: round;
    pointer-events: none;
  }
  input {
    width: 100%;
    height: 2.5rem;
    padding: 0 1rem 0 2.5rem;
    border-radius: 8px;
    box-shadow: var(--card-shadow);
  }
</style>
