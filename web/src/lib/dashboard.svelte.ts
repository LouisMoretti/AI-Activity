// Dashboard state: data source (live or ?demo=1), provider filter, auth,
// and the 15 s auto-refresh (skipped while hidden or already in flight).
import { api, UnauthorizedError } from "./api.ts";
import { demoDashboard } from "./demo.ts";
import { ACTIVITY_DAYS, liveDashboard, STATS_DAYS, type LiveData } from "./live.ts";
import type { DashboardVM, Provider } from "./view-model.ts";

export type Status = "loading" | "ready" | "locked" | "error";

const REFRESH_MS = 15000;

export class Dashboard {
  readonly demo = new URLSearchParams(location.search).get("demo") === "1";
  provider = $state<Provider>("all");
  status = $state<Status>("loading");
  private live = $state<LiveData | null>(null);
  private inFlight = false;

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
    if (this.inFlight) return;
    this.inFlight = true;
    const tool = this.provider === "all" ? null : this.provider;
    try {
      const [stats, activity, quotas, sessions, billing] = await Promise.all([
        api.stats(STATS_DAYS, tool),
        api.activity(ACTIVITY_DAYS, tool),
        api.quotas(),
        api.sessions(10),
        api.billing(),
      ]);
      this.live = { stats, activity, quotas, sessions, billing };
      this.status = "ready";
    } catch (e) {
      this.status = e instanceof UnauthorizedError ? "locked" : "error";
    } finally {
      this.inFlight = false;
    }
  }

  setProvider(p: Provider): void {
    this.provider = p;
    void this.load();
  }

  async login(password: string): Promise<boolean> {
    if (!(await api.login(password))) return false;
    await this.load();
    return true;
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
