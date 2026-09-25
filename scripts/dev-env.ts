// Loads .env for `npm run dev`. Node's --watch also watches the file given to
// --env-file-if-exists and crashes with ENOENT when it does not exist, so the
// dev script loads it here instead. Real environment variables still win.
// Edits to .env need a restart in dev (the watcher only follows imports).
import fs from "node:fs";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
