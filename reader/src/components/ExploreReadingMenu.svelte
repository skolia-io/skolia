<script lang="ts">
  import type { DocumentId } from "@skolia/shared/api";
  import SaveToLists from "./SaveToLists.svelte";
  let { id, title }: { id: DocumentId; title: string } = $props();
</script>

<SaveToLists {id} {title} />
