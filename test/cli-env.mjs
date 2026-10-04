// Real CLIs run in an isolated home. Pass only OS/runtime settings from the
// caller so a manual smoke cannot inherit provider credentials or endpoints.
const RUNTIME_ENV = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "PROGRAMDATA", "PSMODULEPATH",
  "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "LANG", "LC_ALL",
  "LC_CTYPE", "TERM", "COLORTERM", "SHELL", "USER", "USERNAME", "CI",
  "GITHUB_ACTIONS", "TZ",
]);
export const runtimeEnv = (source = process.env) => Object.fromEntries(Object.entries(source)
  .filter(([name]) => RUNTIME_ENV.has(name.toUpperCase())));
