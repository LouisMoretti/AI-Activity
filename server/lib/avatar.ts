// Profile pictures are links, never uploads. Every visitor's browser loads
// them (profiles and the leaderboard are public, sign-up is open), so an
// arbitrary host would let anyone log the IP and browser of every viewer.
// Only big image hosts that give the uploader no access logs are allowed.

export const AVATAR_URL_MAX = 500;

const HOSTS: Record<string, RegExp> = {
  "avatars.githubusercontent.com": /^\/(u\/\d+|[A-Za-z0-9-]+)$/,
  "github.com": /^\/[A-Za-z0-9-]{1,39}\.png$/,
  "gravatar.com": /^\/avatar\/[0-9a-f]{32,64}$/i,
  "www.gravatar.com": /^\/avatar\/[0-9a-f]{32,64}$/i,
  "secure.gravatar.com": /^\/avatar\/[0-9a-f]{32,64}$/i,
  "i.imgur.com": /^\/[A-Za-z0-9]{5,10}\.(png|jpe?g|gif|webp)$/i,
};

export const AVATAR_HOSTS_TEXT = "GitHub, Gravatar or Imgur";

/**
 * Normalized URL, null to clear, or an error message.
 * Accepts only https links to the hosts above, without credentials or port.
 */
export function parseAvatarUrl(v: unknown): { url: string | null } | { error: string } {
  if (v === null || (typeof v === "string" && !v.trim())) return { url: null };
  if (typeof v !== "string" || v.length > AVATAR_URL_MAX) return { error: "invalid picture link" };
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    return { error: "invalid picture link" };
  }
  const path = HOSTS[u.hostname];
  if (u.protocol !== "https:" || u.username || u.password || u.port || !path || !path.test(u.pathname)) {
    return { error: `picture links must be https images from ${AVATAR_HOSTS_TEXT}` };
  }
  u.hash = "";
  return { url: u.toString() };
}
