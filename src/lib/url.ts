// The "unsecured website" rule of Health (SPEC 7), the same as Rust's
// health::is_unsecured_url: an http:// URL to a host that is not local.

/** The host of a URL, lower case; null when the URL cannot be read. */
function hostname(url: string): string | null {
  const raw = (url ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    return u.hostname ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** localhost, loopback, RFC 1918, link-local, IPv6 ULA and ".local" names count as private. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h) || h.startsWith("fe80:")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** An http:// URL to a public host. */
export function isUnsecuredUrl(url: string): boolean {
  if (!/^http:\/\//i.test(url.trim())) return false;
  const host = hostname(url);
  return !!host && !isPrivateHost(host);
}

/**
 * "Use HTTPS": only the URLs that Health flags change to https://. An http:// URL
 * to localhost or a private address stays as it is (a router page often has no https).
 */
export function upgradeUnsecuredUrls<T extends { url: string }>(urls: T[]): T[] {
  return urls.map((u) => (isUnsecuredUrl(u.url) ? { ...u, url: u.url.trim().replace(/^http:\/\//i, "https://") } : u));
}
