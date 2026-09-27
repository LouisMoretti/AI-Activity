// Clipboard writes of text that is still being fetched (a device key).

/**
 * Copy text that may still be loading. The write starts in the click
 * itself (ClipboardItem takes a promise): Safari refuses a write that only
 * starts after a request returns. Throws when the clipboard is unavailable.
 */
export async function copyPending(text: Promise<string>): Promise<void> {
  if (typeof ClipboardItem !== "undefined") {
    const blob = text.then((t) => new Blob([t], { type: "text/plain" }));
    await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
  } else {
    await navigator.clipboard.writeText(await text);
  }
}

/** The one-command install of a device (README.md): the key is in the command, never in a URL. */
export function installCommand(key: string, origin = location.origin): string {
  return `curl -fsSL ${origin}/install.sh | AI_ACTIVITY_URL=${origin} AI_ACTIVITY_KEY=${key} sh`;
}
