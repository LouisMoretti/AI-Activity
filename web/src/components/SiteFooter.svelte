<script lang="ts">
  // Site analytics and non-affiliation notices, on every page (rendered
  // once in App.svelte). Keep the analytics line in step with README.md's
  // "Site analytics" section and web/src/lib/visitor.ts.
</script>

<footer>
  <p>
    Site visits are counted on this server, for its admins only: no cookie,
    nothing sent to third parties, and this browser keeps a random visitor
    id for 13 months.
    <a href="https://github.com/LouisMoretti/AI-Activity#site-analytics" rel="noopener noreferrer">How it works</a>
  </p>
  <p>
    AI Activity is an independent project, not affiliated with, endorsed or
    sponsored by Anthropic, OpenAI, Anysphere, Google or the OpenCode project. Claude, Claude Code,
    Codex, Cursor, Antigravity, OpenCode and the other names shown are trademarks of their
    respective owners, used only to identify the tools whose usage is measured.
  </p>
</footer>

<style>
  footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--line); color: var(--faint); font-size: 11px; line-height: 1.6; text-align: center; overflow-wrap: anywhere; }
  p { margin: 0; }
  p + p { margin-top: 6px; }
  a { color: var(--muted); text-decoration: underline; text-underline-offset: 2px; white-space: nowrap; }
  a:hover { color: var(--text); }
  a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
</style>
