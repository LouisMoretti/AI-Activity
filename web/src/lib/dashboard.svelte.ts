// Dashboard state: sign-in, which profile is shown (/u/<username>, or the
// viewer's own at /), data source (live or ?demo=1), provider filter,
// session paging, and the 15 s auto-refresh (skipped while hidden or
// already in flight).
import { api, NotFoundError, UnauthorizedError } from "./api.ts";
import { demoDashboard } from "./demo.ts";
import { ACTIVITY_DAYS, liveDashboard, type LiveData } from "./live.ts";
import type { DashboardVM, Provider } from "./view-model.ts";
import type { Account, Profile, SessionsResponse } from "../../../shared/types.ts";

/** "signed-out": login screen; "setup": no account exists yet; "missing": unknown profile. */
export type Status = "loading" | "ready" | "signed-out" | "setup" | "missing" | "error";

const REFRESH_MS = 15000;
/** Server-side cap on one /api/sessions page. */
const SESSIONS_MAX_PAGE = 200;
export const SESSIONS_PAGE = 10;

/** The first `limit` sessions, in as many server pages as needed. */
async function fetchSessions(limit: number, tool: string | null, user: string | null): Promise<SessionsResponse> {
  const first = await api.sessions(Math.min(limit, SESSIONS_MAX_PAGE), tool, 0, user);
  const sessions = [...first.sessions];
  while (sessions.length < Math.min(limit, first.total)) {
    const page = await api.sessions(Math.min(limit - sessions.length, SESSIONS_MAX_PAGE), tool, sessions.length, user);
    if (!page.sessions.length) break;
    sessions.push(...page.sessions);
  }
  return { ...first, sessions };
}

/** Username from /u/<username>, or null for the viewer's own page. */
function profileFromPath(): string | null {
  const m = location.pathname.match(/^\/u\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

export const profilePath = (username: string | null) =>
  username ? `/u/${encodeURIComponent(username)}` : "/";

export class Dashboard {
  readonly demo = new URLSearchParams(location.search).get("demo") === "1";
  provider = $state<Provider>("all");
  status = $state<Status>("loading");
  sessionsLimit = $state(SESSIONS_PAGE);
  /** The signed-in account; null when signed out. */
  account = $state<Account | null>(null);
  profiles = $state<Profile[]>([]);
  /** Username in the URL; null (or the viewer's own name) means the own page. */
  viewing = $state<string | null>(profileFromPath());
  private live = $state<LiveData | null>(null);
  private inFlight = false;
  private reloadQueued = false;

  /** True on the viewer's own page, where private sections are shown. */
  own = $derived(!this.viewing || this.viewing.toLowerCase() === this.account?.username.toLowerCase());
  /** The profile being shown, for titles. */
  shown = $derived<Profile | null>(
    this.own
      ? (this.account && { username: this.account.username, display_name: this.account.display_name })
      : (this.profiles.find((p) => p.username.toLowerCase() === this.viewing?.toLowerCase()) ?? null)
  );

  vm = $derived<DashboardVM | null>(
    !this.account ? null
      : this.demo ? demoDashboard(this.provider)
        : this.live ? liveDashboard(this.live, this.provider)
          : null
  );

  async load(): Promise<void> {
    if (this.inFlight) {
      // A filter, paging or profile change during a refresh must not be lost.
      this.reloadQueued = true;
      return;
    }
    this.inFlight = true;
    const tool = this.provider === "all" ? null : this.provider;
    const target = this.viewing;
    try {
      // Nothing, demo included, is shown without a signed-in account.
      const auth = await api.authStatus();
      if (!auth.user) {
        this.signedOut(auth.setup_required ? "setup" : "signed-out");
        return;
      }
      this.account = auth.user;
      if (this.demo) {
        this.status = "ready";
        return;
      }
      const user = this.own ? null : target;
      const [profiles, summary, activity, quotas, sessions, billing] = await Promise.all([
        api.profiles(),
        api.summary(tool, user),
        api.activity(ACTIVITY_DAYS, tool, user),
        api.quotas(user),
        fetchSessions(this.sessionsLimit, tool, user),
        user ? null : api.billing(),
      ]);
      // A profile switch while this was in flight: its queued reload wins.
      if (target !== this.viewing) return;
      this.profiles = profiles.profiles;
      this.live = { summary, activity, quotas, sessions, billing };
      this.status = "ready";
    } catch (e) {
      if (e instanceof UnauthorizedError) this.signedOut("signed-out");
      else if (e instanceof NotFoundError) {
        this.live = null;
        this.status = "missing";
      } else this.status = "error";
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

  /** Show a profile (null: the viewer's own) and record it in the URL. */
  openProfile(username: string | null): void {
    const own = !username || username.toLowerCase() === this.account?.username.toLowerCase();
    history.pushState(null, "", profilePath(own ? null : username) + location.search);
    this.showPath();
  }

  /** Sync with the URL (after openProfile, or back/forward). */
  private showPath(): void {
    this.viewing = profileFromPath();
    this.live = null;
    this.sessionsLimit = SESSIONS_PAGE;
    this.status = "loading";
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
    this.signedOut("signed-out");
  }

  /** Drop everything the previous account could see. */
  private signedOut(status: "signed-out" | "setup"): void {
    this.account = null;
    this.live = null;
    this.profiles = [];
    this.sessionsLimit = SESSIONS_PAGE;
    this.status = status;
  }

  /** Starts polling; returns a cleanup function. */
  start(): () => void {
    void this.load();
    const onPop = () => this.showPath();
    window.addEventListener("popstate", onPop);
    const tick = () => { if (!document.hidden && !this.demo) void this.load(); };
    const id = setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      window.removeEventListener("popstate", onPop);
      document.removeEventListener("visibilitychange", tick);
    };
  }
}
