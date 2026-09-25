// AI Activity trigger for OpenCode (see README.md, "Send OpenCode usage").
// Copied to ~/.config/opencode/plugins/ai-activity.js: runs the collector
// (../ai-activity-opencode.py, next to the plugins folder) when OpenCode
// starts and whenever a session goes idle. The collector reads OpenCode's
// own database, which is the durable record: nothing is queued here.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../ai-activity-opencode.py", import.meta.url));

let running = false;
let again = false;

/** One detached run at a time; an idle session meanwhile runs it once more after. */
function collect() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  const done = () => {
    running = false;
    if (again) {
      again = false;
      collect();
    }
  };
  try {
    const p = spawn("python3", [SCRIPT], { detached: true, stdio: "ignore" });
    p.on("exit", done);
    p.on("error", done); // no python3: never break OpenCode
    p.unref();
  } catch {
    done();
  }
}

export const AIActivity = async () => {
  collect();
  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") collect();
    },
  };
};
