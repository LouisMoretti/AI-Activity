// Collector versions (issue #125): each collector's VERSION matches
// COLLECTOR_VERSIONS, a changed collector file needs a new version, and
// every collector sends its version and surfaces the server's update hint.
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { COLLECTOR_VERSIONS, MIN_COLLECTOR_VERSIONS } from "../shared/collectors.ts";
import { TOOLS } from "../shared/types.ts";
import { checkCollector } from "../server/lib/ingest.ts";
import { PYTHON, tempHome, collectorTarget } from "./helpers.js";

const dir = new URL("../collectors/", import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, dir), "utf8").replaceAll("\r\n", "\n");
/** The files of each collector: a change to any of them is a new version. */
const FILES = {
  "claude-code": ["claude-code.py"],
  codex: ["codex.py"],
  antigravity: ["antigravity.py"],
  opencode: ["opencode.py", "opencode-plugin.js"],
};
/**
 * The version each collector's files had when last recorded. When this test
 * fails after editing a collector: bump VERSION in it and in
 * shared/collectors.ts, then record the new version and hash here.
 */
const RECORDED = {
  "claude-code": { version: 4, sha256: "6efc48b10406dcdf6e549efc484f319009fdd7b3d4d37fdf28a9845416efd174" },
  codex: { version: 2, sha256: "a48e3cf19fdff5ae3cd0b9d29f029bf760b49ddf7ff74a444948f67335320c6a" },
  antigravity: { version: 3, sha256: "08d3bc5ac185b28a6122208ff26fde4a4c9938ae801459b1821e09e35de2a381" },
  opencode: { version: 2, sha256: "e9a6b9c8b2b3ca16364657a72058d2b18268d0738efef4f2af1e8f61fd2ca47d" },
};
const digest = (tool) => createHash("sha256").update(FILES[tool].map(read).join("\0")).digest("hex");
const scriptOf = (tool) => FILES[tool].find((f) => f.endsWith(".py"));

describe("collector versions", () => {
  test("every tool has a collector version and a minimum no newer than it", () => {
    assert.deepEqual(Object.keys(COLLECTOR_VERSIONS).sort(), [...TOOLS].sort());
    for (const tool of TOOLS) {
      assert.ok(Number.isSafeInteger(COLLECTOR_VERSIONS[tool]) && COLLECTOR_VERSIONS[tool] > 0, tool);
      assert.ok(MIN_COLLECTOR_VERSIONS[tool] >= 0 && MIN_COLLECTOR_VERSIONS[tool] <= COLLECTOR_VERSIONS[tool], tool);
    }
  });

  test("each collector's VERSION and name match shared/collectors.ts", () => {
    for (const tool of TOOLS) {
      const src = read(scriptOf(tool));
      assert.equal(Number(src.match(/^VERSION = (\d+)$/m)?.[1]), COLLECTOR_VERSIONS[tool], `VERSION in ${scriptOf(tool)}`);
      assert.match(src, new RegExp(`^COLLECTOR = \\{"name": "${tool}", "version": VERSION\\}$`, "m"));
    }
  });

  test("a changed collector has a new version", () => {
    for (const tool of TOOLS) {
      assert.deepEqual({ version: COLLECTOR_VERSIONS[tool], sha256: digest(tool) }, RECORDED[tool],
        `${FILES[tool].join(" / ")} changed: bump VERSION in ${scriptOf(tool)} and in shared/collectors.ts, ` +
        "then record the new version and hash in RECORDED (test/collector-versions.test.js)");
    }
  });

  test("outdated below the latest, refused below the minimum", () => {
    assert.deepEqual(checkCollector("codex", 3, 3, 1), { latest: 3, minimum: 1, outdated: false, refused: false });
    assert.deepEqual(checkCollector("codex", 2, 3, 1), { latest: 3, minimum: 1, outdated: true, refused: false });
    assert.deepEqual(checkCollector("codex", 0, 3, 1), { latest: 3, minimum: 1, outdated: true, refused: true });
    assert.equal(checkCollector("codex", COLLECTOR_VERSIONS.codex).outdated, false);
  });
});

// Loads one collector as a module and posts an empty batch through its own
// upload function, printing "ok" or the HTTP status that stopped it.
const HARNESS = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("collector", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
try:
    if hasattr(m, "upload"):
        m.upload({"messages": []}, {}, "retry_at")
    else:
        m.post({"messages": []})
    print("ok")
except Exception as e:
    print("error %s" % getattr(e, "code", type(e).__name__))
`;

describe("collectors send their version and surface update hints", () => {
  let server, base, mode;
  const bodies = [];
  before(async () => {
    server = http.createServer((request, response) => {
      const chunks = [];
      request.on("data", (c) => chunks.push(c));
      request.on("end", () => {
        bodies.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
        const ok = { ok: true, messages: 0, stored: 0, updated: 0, deduped: 0 };
        const [status, answer] = {
          current: [200, ok],
          outdated: [200, { ...ok, update: { latest: 7, minimum: 0 } }],
          refused: [426, { error: "too old", update: { latest: 7, minimum: 5 } }],
        }[mode];
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(answer));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  for (const tool of TOOLS) {
    test(tool, async () => {
      const home = tempHome("ai-activity-versions-");
      const cache = path.join(home, ".cache", "ai-activity");
      fs.mkdirSync(cache, { recursive: true });
      const flag = path.join(cache, `update-available-${tool}`);
      // Asynchronous: the fake server answers from this same process.
      const run = async (m) => {
        mode = m;
        bodies.length = 0;
        const r = await new Promise((resolve) => execFile(PYTHON, ["-c", HARNESS, fileURLToPath(new URL(scriptOf(tool), dir))], {
          encoding: "utf8", windowsHide: true,
          env: { ...process.env, HOME: home, USERPROFILE: home, AI_ACTIVITY_URL: base, AI_ACTIVITY_KEY: "ak_test" },
        }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
        assert.equal(r.error, null, r.stderr);
        assert.equal(bodies.length, 1);
        assert.equal(bodies[0].url, `/api/ingest/${tool}`);
        assert.deepEqual(bodies[0].body.collector, { name: tool, version: COLLECTOR_VERSIONS[tool] });
        return r;
      };
      try {
        let r = await run("outdated");
        assert.equal(r.stdout.trim(), "ok");
        const notice = `ai-activity ${tool} collector v${COLLECTOR_VERSIONS[tool]} is outdated (latest v7)`;
        assert.match(r.stderr, new RegExp(notice.replace(/[.()]/g, "\\$&")));
        assert.ok(fs.readFileSync(flag, "utf8").startsWith(notice));
        // Up to date again: the notice goes away.
        assert.equal((await run("current")).stdout.trim(), "ok");
        assert.equal(fs.existsSync(flag), false);
        // Refused: the upload fails (the collector keeps its backlog) and says why.
        r = await run("refused");
        assert.equal(r.stdout.trim(), "error 426");
        assert.ok(fs.readFileSync(flag, "utf8").startsWith(notice));
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

// Offsets are kept per server and key (issue #127): every collector must
// fingerprint a target the same way, and the tests compute it like them.
describe("collectors fingerprint their target the same way", () => {
  const CASES = [
    ["https://ai.example.com", "ak_one"],
    ["HTTPS://AI.Example.com/", "ak_one"],
    ["https://ai.example.com//", "ak_one"],
    ["https://ai.example.com:443/", "ak_one"],
    ["https://ai.example.com/sub/path/", "ak_one"],
    ["http://127.0.0.1:3000", "ak_two"],
    ["https://ai.example.com", "ak_two"],
    ["http://127.0.0.1:80", "ak_two"],
    ["http://[::1]:3000/", "ak_two"],
    ["ai.example.com", "ak_two"],
  ];
  const PRINT = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("collector", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
out = []
for server, key in json.loads(sys.argv[2]):
    m.SERVER, m.KEY = server, key
    out.append(m.target())
print(json.dumps(out))
`;
  const expected = CASES.map(([url, key]) => collectorTarget(url, key));

  test("the same server written differently is one target; another key or server is another", () => {
    assert.equal(new Set(expected.slice(0, 4)).size, 1);
    assert.equal(new Set(expected).size, 7);
    assert.ok(expected.every((fp) => /^[0-9a-f]{16}$/.test(fp)));
  });

  // The 8 most recently used targets are kept: the one in use goes last.
  const KEEP = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("collector", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.SERVER, m.KEY = "https://ai.example.com", "ak_one"
saved = {"targets": {"old%d" % i: {"n": i} for i in range(9)}}
saved["targets"][m.target()] = {"mine": 1}
saved["targets"]["old9"] = {"n": 9}
kept = m.for_target(saved)
print(json.dumps([list(kept[0]["targets"]), kept[1]]))
`;

  for (const tool of TOOLS) {
    test(`${tool}: keeps the 8 most recent targets`, () => {
      const [kept, mine] = JSON.parse(execFileSync(PYTHON, ["-c", KEEP, fileURLToPath(new URL(scriptOf(tool), dir))],
        { encoding: "utf8", windowsHide: true }));
      const fp = collectorTarget("https://ai.example.com", "ak_one");
      assert.deepEqual(kept, ["old3", "old4", "old5", "old6", "old7", "old8", "old9", fp]);
      assert.deepEqual(mine, { mine: 1 });
    });
  }

  for (const tool of TOOLS) {
    test(tool, () => {
      const out = execFileSync(PYTHON, ["-c", PRINT, fileURLToPath(new URL(scriptOf(tool), dir)), JSON.stringify(CASES)],
        { encoding: "utf8", windowsHide: true });
      assert.deepEqual(JSON.parse(out), expected);
    });
  }
});
