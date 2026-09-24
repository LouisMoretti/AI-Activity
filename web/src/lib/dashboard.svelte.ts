// Dashboard state: data source (live or ?demo=1), provider filter, auth,
// session paging, and the 15 s auto-refresh (skipped while hidden or
// already in flight).
import { api, UnauthorizedError } from "./api.ts";
import { demoDashboard } from "./demo.ts";
import { ACTIVITY_DAYS, liveDashboard, type LiveData } from "./live.ts";
import type { DashboardVM, Provider } from "./view-model.ts";
import type { Account, SessionsResponse } from "../../../shared/types.ts";

export type Status = "loading" | "ready" | "locked" | "error";

const REFRESH_MS = 15000;
/** Server-side cap on one /api/sessions page. */
const SESSIONS_MAX_PAGE = 200;
export const SESSIONS_PAGE = 10;

/** The first `limit` sessions, in as many server pages as needed. */
async function fetchSessions(limit: number, tool: string | null): Promise<SessionsResponse> {
  const first = await api.sessions(Math.min(limit, SESSIONS_MAX_PAGE), tool);
  const sessions = [...first.sessions];
  while (sessions.length < Math.min(limit, first.total)) {
    const page = await api.sessions(Math.min(limit - sessions.length, SESSIONS_MAX_PAGE), tool, sessions.length);
    if (!page.sessions.length) break;
    sessions.push(...page.sessions);
  }
  return { ...first, sessions };
}

export class Dashboard {
  readonly demo = new URLSearchParams(location.search).get("demo") === "1";
  provider = $state<Provider>("all");
  status = $state<Status>("loading");
  sessionsLimit = $state(SESSIONS_PAGE);
  /** The signed-in account; null while the dashboard is open (no accounts) or signed out. */
  account = $state<Account | null>(null);
  private live = $state<LiveData | null>(null);
  private inFlight = false;
  private reloadQueued = false;

  vm = $derived<DashboardVM | null>(
    this.demo ? demoDashboard(this.provider)
      : this.live ? liveDashboard(this.live, this.provider)
        : null
  );

  async load(): Promise<void> {
    if (this.demo) {
      this.status = "ready";
      return;
    }
    if (this.inFlight) {
      // A filter or paging change during a refresh must not be lost.
      this.reloadQueued = true;
      return;
    }
    this.inFlight = true;
    const tool = this.provider === "all" ? null : this.provider;
    try {
      const [auth, summary, activity, quotas, sessions, billing] = await Promise.all([
        api.authStatus(),
        api.summary(tool),
        api.activity(ACTIVITY_DAYS, tool),
        api.quotas(),
        fetchSessions(this.sessionsLimit, tool),
        api.billing(),
      ]);
      this.account = auth.user;
      this.live = { summary, activity, quotas, sessions, billing };
      this.status = "ready";
    } catch (e) {
      if (e instanceof UnauthorizedError) this.signedOut();
      else this.status = "error";
    } finally {
      this.inFlight = false;
      if (this.reloadQueued) {
        this.reloadQueued = false;
        void this.load();
      }
    }
  }

  setProvider(p: Provider): void {
    this.provider = p;
    this.sessionsLimit = SESSIONS_PAGE;
    void this.load();
  }

  showMoreSessions(): void {
    this.sessionsLimit += SESSIONS_PAGE;
    void this.load();
  }

  /** An error message, or null once signed in. */
  async login(username: string, password: string): Promise<string | null> {
    try {
      await api.login(username, password);
    } catch (e) {
      return e instanceof UnauthorizedError ? "Wrong username or password." : (e as Error).message;
    }
    await this.load();
    return null;
  }

  async logout(): Promise<void> {
    await api.logout().catch(() => {});
    this.signedOut();
  }

  /** Drop everything the previous account could see. */
  private signedOut(): void {
    this.account = null;
    this.live = null;
    this.sessionsLimit = SESSIONS_PAGE;
    this.status = "locked";
  }

  /** Starts polling; returns a cleanup function. */
  start(): () => void {
    void this.load();
    if (this.demo) return () => {};
    const tick = () => { if (!document.hidden) void this.load(); };
    const id = setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }
}
