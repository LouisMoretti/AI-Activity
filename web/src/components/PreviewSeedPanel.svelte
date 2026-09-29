<script lang="ts">
  import { onMount } from "svelte";
  import type { PreviewSeedConfig } from "../../../shared/types.ts";
  import { api } from "../lib/api.ts";

  let json = $state("");
  let error = $state("");
  let result = $state("");
  let generating = $state(false);

  onMount(async () => {
    try {
      json = JSON.stringify((await api.previewSeed()).config, null, 2);
    } catch (e) {
      error = (e as Error).message;
    }
  });

  async function generate() {
    error = "";
    result = "";
    let config: PreviewSeedConfig;
    try {
      config = JSON.parse(json) as PreviewSeedConfig;
    } catch {
      error = "Enter valid JSON before generating sample data.";
      return;
    }
    generating = true;
    try {
      const response = await api.generatePreviewSeed(config);
      json = JSON.stringify(response.config, null, 2);
      result = `Generated ${response.events} fictional events for @${response.username}. Public pages will update on refresh.`;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      generating = false;
    }
  }
</script>

<div class="panel">
  <p>Set <code>target</code> to <code>self</code> (default) to add activity to your profile, or <code>preview_user</code> for a separate fictional profile. Events use a device named <code>preview</code>. Generating again replaces only events from that device; your measured activity stays.</p>
  <label for="preview-seed-json">Sample settings (JSON)</label>
  <textarea id="preview-seed-json" bind:value={json} spellcheck="false" rows="17" disabled={generating} aria-describedby="preview-seed-help"></textarea>
  <small id="preview-seed-help">1–365 days, 1–20 events per day, up to 5,000 events. Use supported tool slugs: claude-code, codex, antigravity, opencode.</small>
  <button type="button" disabled={generating || !json} onclick={generate}>{generating ? "Generating…" : "Generate sample data"}</button>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if result}<p class="success" role="status">{result}</p>{/if}
</div>

<style>
  .panel { border: 1px solid var(--line); border-radius: var(--radius); padding: 18px; }
  p { margin: 0 0 14px; color: var(--muted); font-size: 13px; line-height: 1.6; }
  label { display: block; margin-bottom: 8px; font-size: 13px; font-weight: 500; }
  textarea { box-sizing: border-box; width: 100%; padding: 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--bg); color: var(--text); font: 12px/1.5 monospace; resize: vertical; }
  textarea:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  small { display: block; margin-top: 8px; color: var(--muted); font-size: 12px; }
  button { margin-top: 14px; padding: 9px 14px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--accent); color: var(--bg); font-weight: 600; }
  button:disabled { opacity: .55; cursor: not-allowed; }
  .error, .success { margin: 12px 0 0; }
  .error { color: var(--warn); }
  .success { color: var(--text); }
</style>
