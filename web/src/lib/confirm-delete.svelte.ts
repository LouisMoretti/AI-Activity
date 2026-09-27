// The Settings danger zone's actions ("Delete activity", "Delete my
// account"): closed, then a confirmation form (password + typed phrase),
// then done or an error. Kept apart from the component so their states can
// be tested (test/confirm-delete.test.js).
import { api } from "./api.ts";
import {
  DELETE_ACCOUNT_PHRASE, DELETE_ACTIVITY_PHRASE, type DeletedAccount, type DeletedActivity,
} from "../../../shared/types.ts";

export type DeleteStep = "closed" | "confirming" | "busy" | "done";

/** One destructive action confirmed by the password and a typed phrase. */
export class ConfirmDelete<T> {
  step = $state<DeleteStep>("closed");
  password = $state("");
  phrase = $state("");
  error = $state<string | null>(null);
  result = $state<T | null>(null);

  readonly expected: string;
  private run: (password: string, confirm: string) => Promise<T>;
  private ondone: (result: T) => void;

  /** `run` calls the server; `ondone` follows a success (reload, sign out). */
  constructor(expected: string, run: (password: string, confirm: string) => Promise<T>, ondone: (result: T) => void) {
    this.expected = expected;
    this.run = run;
    this.ondone = ondone;
  }

  /** The phrase matches (case and surrounding spaces ignored) and a password is typed. */
  get ready(): boolean {
    return this.password !== "" && this.phrase.trim().toLowerCase() === this.expected;
  }

  open(): void {
    this.step = "confirming";
    this.result = null;
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
      const result = await this.run(this.password, this.expected);
      this.result = result;
      this.step = "done";
      this.password = this.phrase = "";
      this.ondone(result);
    } catch (err) {
      this.error = (err as Error).message;
      this.step = "confirming";
      this.password = "";
    }
  }
}

/** Deletes the signed-in user's usage and quotas; `ondeleted` reloads the page. */
export class DeleteActivity extends ConfirmDelete<DeletedActivity> {
  constructor(ondeleted: () => void) {
    super(DELETE_ACTIVITY_PHRASE, async (p, c) => (await api.deleteActivity(p, c)).deleted, ondeleted);
  }

  get deleted(): DeletedActivity | null {
    return this.result;
  }
}

/** Deletes the signed-in user's account; `onsignout` follows (the session is gone). */
export class DeleteAccount extends ConfirmDelete<DeletedAccount> {
  constructor(onsignout: () => void) {
    super(DELETE_ACCOUNT_PHRASE, async (p, c) => (await api.deleteAccount(p, c)).deleted, onsignout);
  }
}
