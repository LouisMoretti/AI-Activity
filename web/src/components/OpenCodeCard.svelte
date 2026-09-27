<script lang="ts">
  import type { ActivityToolVM } from "../lib/view-model.ts";
  import ActivityToolCard from "./ActivityToolCard.svelte";

  let { vm }: { vm: ActivityToolVM } = $props();
</script>

<!-- OpenCode has no 5-hour / weekly quota of its own: no quota windows. -->
<ActivityToolCard tool="opencode" {vm} />
