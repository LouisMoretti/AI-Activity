<script lang="ts">
  import { DeleteAccount, DeleteActivity } from "../lib/confirm-delete.svelte.ts";
  import { fmtNum } from "../lib/format.ts";
  import DangerAction from "./DangerAction.svelte";

  let { ondeletedactivity, onsignout, onreauth }: {
    /** Reload: totals, calendar, quotas and conversations are now empty. */
    ondeletedactivity: () => void;
    /** Sign out: the account and its sessions are gone. */
    onsignout: () => void;
    /** Sign in with GitHub again, back to Settings: deleting needs a recent sign-in. */
    onreauth: () => Promise<string | null>;
  } = $props();

  const activity = new DeleteActivity(() => ondeletedactivity());
  const account = new DeleteAccount(() => onsignout());
</script>

<div class="grid">
  <DangerAction title="Delete activity" flow={activity} {onreauth}
    actionLabel="Delete activity…" confirmLabel="Delete all my activity"
    success={(d) => `Deleted ${fmtNum(d.events)} API calls and ${fmtNum(d.quotas)} quota measurements.`}>
    Deletes every token count, conversation, calendar day and quota measured for your account, on every
    device. Your account, profile, devices and keys stay. Collectors that send the deleted activity again
    are refused; new activity keeps being recorded. Server backups made before keep a copy until they are
    pruned (about four weeks) or an admin deletes them.
  </DangerAction>

  <DangerAction title="Delete my account" flow={account} {onreauth}
    actionLabel="Delete my account…" confirmLabel="Delete my account">
    Deletes your account and everything tied to it: your activity, quotas, profile, devices and their
    keys (the collectors on your machines are refused from then on) and every session. Your username
    becomes free for anyone to take. Server backups made before keep a copy until they are pruned (about
    four weeks) or an admin deletes them. The last admin cannot leave: make another account admin first.
  </DangerAction>
</div>

<style>
  .grid { display: grid; gap: 16px; }
</style>
