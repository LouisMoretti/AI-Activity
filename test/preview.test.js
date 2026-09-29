import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

// Exercise the real deployment script against a stateful host boundary.
// Docker/mount/firewall integration is covered separately by CI's smoke test.
import { once } from "node:events";

const script = resolve("deploy/ai-activity-preview");
const sha = "a".repeat(40);
const image = "ghcr.io/louismoretti/ai-activity-preview";
function host(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "preview-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const d of ["bin", "state", "data"]) mkdirSync(join(root, d));
  writeFileSync(join(root, "state", "compose.preview.yaml"), "");
  writeFileSync(join(root, "state", ".env"), "PREVIEW_DOMAIN=preview.test\n");
  const mock = join(root, "mock.cjs");
  writeFileSync(mock, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.HOST_ROOT;
const cmd = path.basename(process.argv[1]);
const a = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls'), JSON.stringify([cmd, ...a]) + '\\n');
const out = s => console.log(s);
const die = n => process.exit(n);
if (cmd === 'id') out('1000');
if (cmd === 'sleep') die(0);
if (cmd === 'findmnt') { if (process.env.NO_MOUNT) die(1); out(process.env.MOUNT || 'ext4 3221225472'); }
if (cmd === 'stat') out(process.env.SAME_FS ? '1' : a.at(-1).endsWith('/data') ? '2' : '1');
if (cmd === 'df') {
  const free = process.env.LOW_DISK && !(process.env.RECLAIM && fs.existsSync(path.join(root, 'reclaimed'))) ? 1 : 20;
  out('Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/test 99999999 0 ' + free * 1048576 + ' 1% /docker');
}
if (cmd === 'sudo') die(process.env.BAD_FIREWALL ? 1 : 0);
if (cmd === 'docker') {
  if (a[0] === 'info') out('/docker');
  if (a[0] === 'network') out(process.env.NETWORK || 'bridge false ai-preview 172.29.95.0/24 172.29.95.128/25 172.29.95.1');
  if (a[0] === 'pull') {
    const file = path.join(root, 'pulls');
    const n = fs.existsSync(file) ? +fs.readFileSync(file) + 1 : 1;
    fs.writeFileSync(file, String(n));
    if (n <= +(process.env.PULL_FAILURES || 0)) die(1);
  }
  if (a[0] === 'image' && a[1] === 'inspect') out(process.env.VOLUMES || '/data');
  if (a[0] === 'image' && a[1] === 'ls') out('${image}:unused');
  if (a[0] === 'rmi') fs.writeFileSync(path.join(root, 'reclaimed'), '1');
  if (a[0] === 'compose') {
    if (!a.includes('-f') || !a.includes('--env-file')) die(90);
    const project = a[a.indexOf('-p') + 1];
    const resource = path.join(root, project);
    if (a.includes('up')) { fs.writeFileSync(resource, 'container'); if (process.env.FAIL_UP) die(1); }
    if (a.includes('logs')) { out('Setup code: SUPERSECRET'); if (process.env.FAIL_LOGS) die(1); }
    if (a.includes('down')) { if (process.env.FAIL_DOWN) die(1); fs.rmSync(resource, { force: true }); }
  }
}
`, { mode: 0o755 });
  for (const cmd of ["docker", "findmnt", "stat", "df", "sudo", "id", "sleep"]) symlinkSync(mock, join(root, "bin", cmd));
  const env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, HOST_ROOT: root,
    AI_ACTIVITY_PREVIEW_DIR: join(root, "state"), AI_ACTIVITY_PREVIEW_DATA_ROOT: join(root, "data"), ...overrides };
  delete env.SSH_ORIGINAL_COMMAND;
  return { root, env,
    run: (...args) => spawnSync("bash", [script, ...args], { env, encoding: "utf8" }),
    calls: () => existsSync(join(root, "calls")) ? readFileSync(join(root, "calls"), "utf8").trim().split("\n").map(JSON.parse) : [],
    has: p => existsSync(join(root, p)),
    settings: s => writeFileSync(join(root, "state", ".env"), `PREVIEW_DOMAIN=preview.test\n${s}\n`),
  };
}
const linux = { skip: process.platform !== "linux" };
test("preview: failed first up removes its slot, data and resources even if logs fail", linux, t => {
  const h = host(t, { FAIL_UP: "1", FAIL_LOGS: "1" });
  const r = h.run("up", "12", sha, "alice");
  assert.equal(r.status, 1, r.stderr);
  for (const p of ["state/pr-12", "data/pr-12", "ai-activity-pr-12"]) assert.equal(h.has(p), false, p);
  assert.doesNotMatch(r.stdout + r.stderr, /SUPERSECRET/);
  const down = h.calls().find(c => c.includes("down"));
  assert.ok(down.includes("--volumes") && down.includes("--remove-orphans"));
});
test("preview: successful updates and failed updates keep existing data", linux, t => {
  const h = host(t);
  assert.equal(h.run("up", "12", sha, "alice").status, 0);
  const file = join(h.root, "data/pr-12/measured-data");
  writeFileSync(file, "keep");
  assert.equal(h.run("up", "12", "b".repeat(40), "alice,bob").status, 0);
  h.env.FAIL_UP = "1";
  assert.equal(h.run("up", "12", "c".repeat(40), "alice").status, 1);
  assert.equal(readFileSync(file, "utf8"), "keep");
  assert.equal(h.calls().some(c => c.includes("down")), false);
  assert.equal(h.run("down", "12").status, 0);
  assert.equal(h.has("data/pr-12"), false);
});
test("preview: pulls retry, with no slot allocated until a successful pull", linux, t => {
  const h = host(t, { PULL_FAILURES: "3" });
  assert.equal(h.run("up", "12", sha, "alice").status, 1);
  assert.equal(h.calls().filter(c => c[1] === "pull").length, 3);
  assert.equal(h.has("state/pr-12"), false);
  h.env.PULL_FAILURES = "4";
  assert.equal(h.run("up", "12", sha, "alice").status, 0);
  assert.equal(h.calls().filter(c => c[1] === "pull").length, 5);
});
test("preview: unsafe storage, network, firewall and image volumes fail before starting", linux, async t => {
  for (const env of [{ NO_MOUNT: "1" }, { MOUNT: "ext4 4294967296" }, { MOUNT: "xfs 100" },
    { SAME_FS: "1" }, { BAD_FIREWALL: "1" }, { NETWORK: "bridge true ai-preview" },
    { NETWORK: "bridge false br-random" }, { VOLUMES: "/data\n/escape" }]) {
    await t.test(JSON.stringify(env), t => {
      const h = host(t, env);
      assert.notEqual(h.run("up", "12", sha, "alice").status, 0);
      assert.equal(h.has("state/pr-12"), false);
      assert.equal(h.calls().some(c => c[0] === "docker" && c.includes("up")), false);
    });
  }
});
test("preview: limits reject zero retention/cap and negative or quoted values", linux, t => {
  const h = host(t);
  for (const setting of ["PREVIEW_DAYS=0", "PREVIEW_MAX=0", "PREVIEW_DAYS=-1", 'PREVIEW_DAYS="1"', "PREVIEW_DAYS=999999999999999999999"] ) {
    h.settings(setting);
    assert.notEqual(h.run("gc").status, 0, setting);
  }
  h.settings("PREVIEW_MIN_FREE_GB=0");
  assert.equal(h.run("up", "12", sha, "alice").status, 0);
  h.settings("PREVIEW_MAX=1");
  assert.notEqual(h.run("up", "13", sha, "alice").status, 0);
});
test("preview: low disk reclaims only preview images, rechecks, and stops if still low", linux, t => {
  const h = host(t);
  assert.equal(h.run("up", "12", sha, "alice").status, 0);
  h.env.LOW_DISK = "1";
  h.env.RECLAIM = "1";
  assert.equal(h.run("gc").status, 0);
  assert.equal(h.calls().some(c => c.includes("stop")), false);
  delete h.env.RECLAIM;
  assert.equal(h.run("gc").status, 0);
  assert.ok(h.calls().some(c => c.includes("stop")));
  assert.equal(h.calls().some(c => c.includes("prune")), false);
  assert.ok(h.calls().filter(c => c[1] === "rmi").every(c => c[2].startsWith(image + ":")));
  assert.equal(h.has("data/pr-12"), true);
});
test("preview: age-based gc erases data and unknown down is scoped and idempotent", linux, t => {
  const h = host(t);
  assert.equal(h.run("up", "12", sha, "alice").status, 0);
  utimesSync(join(h.root, "state/pr-12/.env"), 1, 1);
  assert.equal(h.run("gc").status, 0);
  assert.equal(h.has("data/pr-12"), false);
  assert.equal(h.run("down", "12").status, 0);
  assert.ok(h.calls().some(c => c.includes("label=com.docker.compose.project=ai-activity-pr-12")));
});
test("preview: failed cleanup preserves state for a later down", linux, t => {
  const h = host(t, { FAIL_UP: "1", FAIL_DOWN: "1" });
  assert.equal(h.run("up", "12", sha, "alice").status, 1);
  assert.equal(h.has("state/pr-12/.env"), true);
  delete h.env.FAIL_DOWN;
  assert.equal(h.run("down", "12").status, 0);
  assert.equal(h.has("state/pr-12"), false);
});

test("preview: a busy gc exits without waiting or touching resources", linux, async t => {
  const h = host(t);
  const lock = spawn("flock", ["-x", join(h.root, "state/.lock"), "bash", "-c", "echo locked; read -r release"], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => lock.stdin.end("release\n"));
  await once(lock.stdout, "data");
  const r = spawnSync("bash", [script, "gc"], { env: h.env, encoding: "utf8", timeout: 2000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(h.calls().some(c => c[0] === "docker"), false);
  lock.stdin.end("release\n");
  await once(lock, "exit");
});
