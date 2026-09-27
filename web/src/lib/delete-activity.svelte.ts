// The Settings "Delete activity" flow: closed, then a confirmation form
// (password + typed phrase), then deleted or an error. Kept apart from the
// component so its states can be tested (test/delete-activity.test.js).
import { api } from "./api.ts";
import { DELETE_ACTIVITY_PHRASE, type DeletedActivity } from "../../../shared/types.ts";

export type DeleteStep = "closed" | "confirming" | "busy" | "done";

export class DeleteActivity {
  step = $state<DeleteStep>("closed");
  password = $state("");
  phrase = $state("");
  error = $state<string | null>(null);
  deleted = $state<DeletedActivity | null>(null);

  /** Called once the data is gone, to reload the dashboard. */
  private ondeleted: () => void;

  constructor(ondeleted: () => void) {
    this.ondeleted = ondeleted;
  }

  /** The phrase matches (case and surrounding spaces ignored) and a password is typed. */
  get ready(): boolean {
    return this.password !== "" && this.phrase.trim().toLowerCase() === DELETE_ACTIVITY_PHRASE;
  }

  open(): void {
    this.step = "confirming";
    this.deleted = null;
    this.error = null;
  }

  /** Leaves without deleting anything; the typed password is forgotten. */
  cancel(): void {
    this.step = "closed";
    this.password = this.phrase = "";
    this.error = null;
  }

  async confirm(): Promise<void> {
    if (!this.ready || this.step !== "confirming") return;
    this.step = "busy";
    this.error = null;
    try {
      const r = await api.deleteActivity(this.password, DELETE_ACTIVITY_PHRASE);
      this.deleted = r.deleted;
      this.step = "done";
      this.password = this.phrase = "";
      this.ondeleted();
    } catch (err) {
      this.error = (err as Error).message;
      this.step = "confirming";
      this.password = "";
    }
  }
}
