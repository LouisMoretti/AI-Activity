import type { DB } from "../db/schema.ts";

/** Populate only explicitly disposable PR preview databases with sample rows. */
export function seedPreviewData(db: DB): void {
  db.transaction(() => {
    const sampleGithubId = -2147000000;
    let user = db.prepare("SELECT id FROM users WHERE github_id = ?").get(sampleGithubId) as { id: number } | undefined;
    if (!user) {
      const base = "preview-sample";
      const username = db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE").get(base)
        ? "preview-sample-data" : base;
      const result = db.prepare(
        "INSERT INTO users (github_id, username, display_name, avatar_url, is_admin, created_at) VALUES (?, ?, ?, NULL, 0, ?)"
      ).run(sampleGithubId, username, "Preview sample", Math.floor(Date.now() / 1000));
      user = { id: Number(result.lastInsertRowid) };
    }

    const userId = user.id;
    const now = Math.floor(Date.now() / 1000);
    const device = db.prepare("SELECT id FROM devices WHERE user_id = ? AND name = 'Preview sample data'").get(userId) as { id: number } | undefined;
    const deviceId = device?.id ?? Number(db.prepare(
      "INSERT INTO devices (user_id, name, key_hash, key_prefix, revoked, created_at) VALUES (?, ?, ?, ?, 0, ?)"
    ).run(userId, "Preview sample data", "preview-seed-device", "preview", now).lastInsertRowid);

    db.prepare("DELETE FROM quota_snapshots WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM usage_events WHERE user_id = ?").run(userId);
    const insert = db.prepare(`
      INSERT INTO usage_events (
        event_id, device_id, user_id, tool, session_id, prompt_id, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        context_window_size, context_used_pct, occurred_at, received_at, source, utc_offset_min
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'message', 0)
    `);
    const tools = ["claude-code", "codex", "opencode", "antigravity"];
    const models = ["claude-sonnet-4", "gpt-5", "gemini-2.5-pro", "claude-opus-4"];
    for (let i = 0; i < 96; i++) {
      const day = i % 60;
      const at = now - day * 86400 - (i % 8) * 3600;
      const tool = tools[i % tools.length];
      insert.run(
        `preview-sample-${i}`, deviceId, userId, tool, `preview-session-${Math.floor(i / 3)}`,
        `preview-prompt-${i}`, models[i % models.length], 500 + (i * 137) % 2500,
        100 + (i * 43) % 900, 200 + (i * 71) % 1800, (i * 29) % 500,
        200000, 18 + (i * 7) % 75, at, now
      );
    }
  })();
}
