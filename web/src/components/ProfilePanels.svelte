<script lang="ts">
  import { DEFAULT_PANELS, PANEL_OPTIONS, TOOLS, type HoursResponse, type RankResponse,
    type PanelId, type PanelSize, type PanelView, type ProfilePanel, type Tool, type Widget } from "../../../shared/types.ts";
  import { api } from "../lib/api.ts";
  import { clock } from "../lib/clock.svelte.ts";
  import { hasLiveWindow, toolName, type DashboardVM } from "../lib/view-model.ts";
  import ActivityToolCard from "./ActivityToolCard.svelte";
  import ProfileWidget from "./ProfileWidget.svelte";
  import QuotaCard from "./QuotaCard.svelte";
  import Section from "./Section.svelte";

  let { vm, panels, own, hours, rankInfo, onpanelschange, ondevices }: {
    vm: DashboardVM; panels: ProfilePanel[]; own: boolean;
    hours: HoursResponse | null; rankInfo: RankResponse | null;
    onpanelschange: (panels: ProfilePanel[]) => void; ondevices: () => void;
  } = $props();

  const labels: Record<Widget, string> = {
    "today-by-tool": "Today by tool", "today-by-hour": "Today by hour",
    "best-day": "Best day", leaderboard: "Leaderboard · 7 days",
  };
  const nameOf = (id: PanelId) => (TOOLS as readonly string[]).includes(id) ? toolName(id) : labels[id as Widget];
  const optionName = (option: { id: PanelId; view?: PanelView }) =>
    `${nameOf(option.id)}${canSwitchView(option.id) ? option.view === "activity" ? " · Details" : " · Quotas" : ""}`;
  const panelKey = (panel: { id: PanelId; view?: PanelView }) => `${panel.id}:${panel.view ?? ""}`;
  const isTool = (id: PanelId): id is Tool => (TOOLS as readonly string[]).includes(id);
  const canSwitchView = (id: PanelId) => ["claude-code", "codex", "antigravity"].includes(id);
  const quotaFor = (tool: Tool) => tool === "claude-code" ? vm.claude : tool === "codex" ? vm.codex : tool === "antigravity" ? vm.antigravity : null;
  const activityFor = (tool: Tool) => tool === "claude-code" ? vm.claudeActivity : tool === "codex" ? vm.codexActivity
    : tool === "cursor" ? vm.cursor : tool === "antigravity" ? vm.antigravityActivity : vm.opencode;

  let editing = $state(false);
  let adding = $state(false);
  let saving = $state(false);
  let error = $state("");
  let draft = $state<ProfilePanel[]>([]);
  const shown = $derived(editing && own ? draft : panels);
  const available = $derived(PANEL_OPTIONS.filter((option) => !draft.some((p) => panelKey(p) === panelKey(option))));

  function edit(): void {
    draft = panels.map((p) => ({ ...p }));
    error = "";
    adding = false;
    editing = true;
  }
  function cancel(): void { editing = false; adding = false; error = ""; }
  function add(option: { id: PanelId; view?: PanelView }): void {
    const defaultPanel = DEFAULT_PANELS.find((p) => panelKey(p) === panelKey(option));
    draft = [...draft, defaultPanel ? { ...defaultPanel } : { ...option, size: option.view === "activity" ? "large" : "small" }];
    adding = false;
  }
  function change(index: number, patch: Partial<ProfilePanel>): void {
    draft = draft.map((p, i) => i === index ? { ...p, ...patch } : p);
  }
  function move(index: number, direction: -1 | 1): void {
    const next = [...draft];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    draft = next;
  }
  async function save(): Promise<void> {
    saving = true;
    error = "";
    try {
      const result = await api.savePanels(draft);
      onpanelschange(result.panels);
      editing = false;
      adding = false;
    } catch { error = "Could not save your dashboard. Try again."; }
    finally { saving = false; }
  }
</script>

<Section title="Dashboard panels" subtitle="Your chosen tools and usage cards">
  {#snippet actions()}
    {#if own}
      <div class="actions">
        {#if editing}
          <button type="button" onclick={() => adding = !adding} aria-expanded={adding}>+ Add panel</button>
          <button type="button" onclick={cancel} disabled={saving}>Cancel</button>
          <button type="button" class="primary" onclick={save} disabled={saving}>{saving ? "Saving…" : "Save layout"}</button>
        {:else}
          <button type="button" onclick={edit}>Edit layout</button>
        {/if}
      </div>
    {/if}
  {/snippet}

  {#if editing && own && adding}
    <div class="picker" aria-label="Available panels">
      {#each available as option (panelKey(option))}
        <button type="button" onclick={() => add(option)}>+ {optionName(option)}</button>
      {:else}<span>All panels are already shown.</span>{/each}
    </div>
  {/if}
  {#if editing && own && error}<p class="error" role="alert">{error}</p>{/if}

  <div class="grid" class:editing={editing && own}>
    {#each shown as panel, i (panelKey(panel))}
      <div class="panel" class:small={panel.size === "small"} class:medium={panel.size === "medium"} class:large={panel.size === "large"}>
        {#if editing && own}
          <div class="controls">
            <strong>{optionName(panel)}</strong>
            <button type="button" aria-label="Move {optionName(panel)} left" title="Move earlier" disabled={i === 0} onclick={() => move(i, -1)}>←</button>
            <button type="button" aria-label="Move {optionName(panel)} right" title="Move later" disabled={i === draft.length - 1} onclick={() => move(i, 1)}>→</button>
            <label><span>Size</span><select aria-label="Size of {optionName(panel)}" value={panel.size} onchange={(e) => change(i, { size: e.currentTarget.value as PanelSize })}>
              <option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option>
            </select></label>
            {#if canSwitchView(panel.id)}
              <label><span>View</span><select aria-label="View of {nameOf(panel.id)}" value={panel.view} onchange={(e) => change(i, { view: e.currentTarget.value as PanelView })}>
                <option value="quota" disabled={draft.some((p, n) => n !== i && p.id === panel.id && p.view === "quota")}>Quotas</option>
                <option value="activity" disabled={draft.some((p, n) => n !== i && p.id === panel.id && p.view === "activity")}>Details</option>
              </select></label>
            {/if}
            <button type="button" class="remove" aria-label="Remove {optionName(panel)}" title="Remove panel" onclick={() => draft = draft.filter((_, n) => n !== i)}>×</button>
          </div>
        {/if}
        {#if isTool(panel.id)}
          {@const tool = panel.id}
          {@const quota = quotaFor(tool)}
          {#if panel.view === "quota" && quota && (tool !== "antigravity" || hasLiveWindow(quota, clock.now))}
            <QuotaCard vm={quota} />
          {:else}
            <ActivityToolCard {tool} vm={activityFor(tool)} />
          {/if}
        {:else}
          <ProfileWidget widget={panel.id as Widget} {vm} {hours} {rankInfo} />
        {/if}
      </div>
    {:else}
      <p class="empty">No panels selected.{#if own} {editing ? "Use + Add panel to choose one." : "Use Edit layout to add one."}{/if}</p>
    {/each}
  </div>

  {#if own}
    <p class="howto">Add a tool: run a device's install command from <button type="button" onclick={ondevices}>Settings → Devices</button> on that machine (Linux, macOS or Windows).</p>
  {/if}
</Section>

<style>
  .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
  button, select { border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--text); background: var(--surface); padding: 6px 9px; font-size: 12px; }
  button:hover:not(:disabled) { border-color: var(--accent); }
  button:disabled { opacity: .4; cursor: default; }
  .primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
  .picker { display: flex; flex-wrap: wrap; gap: 8px; padding: 14px; margin-bottom: 16px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); }
  .picker span, .empty { color: var(--muted); font-size: 13px; }
  .error { color: var(--warn); font-size: 13px; margin-bottom: 12px; }
  .grid { display: flex; flex-wrap: wrap; gap: 16px; }
  .panel { min-width: min(100%, 230px); container-type: inline-size; display: flex; flex-direction: column; }
  .panel.small { flex: 0 1 calc((100% - 32px) / 3); }
  .panel.medium { flex: 0 1 calc((100% - 32px) * 2 / 3 + 16px); }
  .panel.large { flex: 0 1 100%; }
  .panel :global(article) { flex: 1; }
  .controls { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; padding: 7px; margin-bottom: 5px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-sm); }
  .controls strong { flex: 1 1 100%; font-size: 11px; font-weight: 500; }
  .controls label { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: 11px; }
  .controls button { padding: 3px 7px; }
  .remove { margin-left: auto; }
  .howto { margin-top: 16px; border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 16px; color: var(--muted); font-size: 13px; line-height: 1.6; }
  .howto button { padding: 0; border: 0; background: none; color: var(--text); text-decoration: underline; text-underline-offset: 2px; }
  @media (max-width: 720px) { .panel.small, .panel.medium, .panel.large { flex-basis: 100%; } }
</style>
