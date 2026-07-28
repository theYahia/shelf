// domain.js — the cataloguing system. Turns a URL into a shelf label and a colour.

// A pragmatic (not exhaustive) list of country-code second-level domains, so that
// "shop.example.co.uk" catalogues under "example.co.uk", not "co.uk".
// ponytail: hand-kept list, not the real Public Suffix List — that's ~15k entries
// and an update pipeline, for a project that ships as plain files with no build.
const CC_SLDS = new Set([
  "co.uk", "org.uk", "me.uk", "ac.uk", "gov.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "co.jp", "or.jp", "ne.jp", "ac.jp",
  "com.br", "com.cn", "com.mx", "com.tr", "com.ar",
  "co.in", "co.za", "co.kr", "co.il", "com.sg", "com.hk",
  "com.ua", "net.ua", "org.ua", "com.ru", "com.pl",
  "co.id", "co.th", "com.vn", "com.my", "com.ph",
  "com.pk", "com.tw", "com.co", "com.pe", "co.ke",
  "org.il", "net.il", "com.sa", "com.ng", "com.eg",
]);

// Hosting suffixes where every subdomain is a *different site*. Without these,
// user1.github.io and user2.github.io share a shelf — two strangers on one spine.
// Same rule as CC_SLDS, opposite intent: keep one more label, not fewer.
const PRIVATE_SUFFIXES = new Set([
  "github.io", "gitlab.io", "pages.dev", "workers.dev",
  "vercel.app", "netlify.app", "web.app", "firebaseapp.com", "herokuapp.com",
  "myshopify.com", "atlassian.net", "blogspot.com", "notion.site",
  "glitch.me", "ngrok-free.app", "s3.amazonaws.com",
]);

const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

// The eight colours Chrome/Brave Tab Groups can paint a group's spine.
// "grey" is reserved as a neutral fallback.
export const GROUP_COLORS = [
  "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange",
];

/**
 * Reduce a URL to its shelf key.
 * @param {string} url
 * @param {{mergeSubdomains?: boolean}} opts
 * @returns {string|null} domain key, or null for URLs that shouldn't be shelved
 *   (chrome://, brave://, about:, file://, etc.)
 */
export function getDomain(url, { mergeSubdomains = true } = {}) {
  let host, port;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null; // skip internal/special pages
    host = u.hostname;
    port = u.port;
  } catch {
    return null;
  }
  if (!host) return null;

  host = host.replace(/^www\./, "");

  // IP addresses and localhost: shelve as-is, no eTLD math — but keep the port, so
  // a developer's localhost:3000 and localhost:8080 get a shelf each.
  if (host === "localhost" || IP_RE.test(host)) return port ? `${host}:${port}` : host;

  if (!mergeSubdomains) return host; // keep mail.example.com distinct from example.com

  const parts = host.split(".");
  if (parts.length <= 2) return host;

  const lastTwo = parts.slice(-2).join(".");
  const lastThree = parts.slice(-3).join(".");
  // A hosting suffix means the label in front of it identifies the *site*, so keep it.
  if (PRIVATE_SUFFIXES.has(lastTwo)) return lastThree;
  if (PRIVATE_SUFFIXES.has(lastThree)) return parts.slice(-4).join(".");
  // ccSLD like "co.uk" -> keep three labels (example.co.uk); otherwise keep two.
  return CC_SLDS.has(lastTwo) ? lastThree : lastTwo;
}

/**
 * Is this URL on the user's do-not-touch list?
 * Checks the full host first (so "localhost:3000" and "localhost" both work), then
 * each parent suffix, so an exception of "google.com" also covers mail.google.com.
 * Stops before the bare TLD: an exception of "com" is a typo, not a wildcard.
 * @param {string} url
 * @param {Set<string>} exceptions lower-cased
 */
export function isExcepted(url, exceptions) {
  if (!exceptions || !exceptions.size) return false;
  let host, port;
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./, "").toLowerCase();
    port = u.port;
  } catch {
    return false;
  }
  if (!host) return false;
  if (port && exceptions.has(`${host}:${port}`)) return true;
  if (exceptions.has(host)) return true;
  const parts = host.split(".");
  for (let i = 1; i <= parts.length - 2; i++) {
    if (exceptions.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

/**
 * Deterministically map a domain to one of the group colours, so the same site
 * always lands on the same coloured spine across sessions.
 */
export function domainToColor(domain) {
  let hash = 0;
  for (let i = 0; i < domain.length; i++) {
    hash = (hash * 31 + domain.charCodeAt(i)) >>> 0;
  }
  return GROUP_COLORS[hash % GROUP_COLORS.length];
}

// --- punycode (RFC 3492) — decode IDN labels like "xn--c1acdymdr" to unicode ---

function punyDigit(c) {
  if (c >= 0x30 && c <= 0x39) return c - 22; // '0'-'9' -> 26-35
  if (c >= 0x41 && c <= 0x5a) return c - 0x41; // 'A'-'Z' -> 0-25
  if (c >= 0x61 && c <= 0x7a) return c - 0x61; // 'a'-'z' -> 0-25
  return 36;
}

function punyAdapt(delta, numPoints, firstTime) {
  delta = firstTime ? Math.floor(delta / 700) : delta >> 1;
  delta += Math.floor(delta / numPoints);
  let k = 0;
  while (delta > 455) {
    delta = Math.floor(delta / 35);
    k += 36;
  }
  return k + Math.floor((36 * delta) / (delta + 38));
}

/** Decode a single punycode label (the part after "xn--"). Returns null on error. */
function decodePunycode(input) {
  const output = [];
  let n = 128, bias = 72, i = 0;
  const basic = input.lastIndexOf("-");
  for (let j = 0; j < (basic < 0 ? 0 : basic); j++) output.push(input.charCodeAt(j));
  let idx = basic < 0 ? 0 : basic + 1;
  while (idx < input.length) {
    const oldi = i;
    let w = 1, k = 36;
    for (;;) {
      if (idx >= input.length) return null;
      const digit = punyDigit(input.charCodeAt(idx++));
      if (digit >= 36) return null;
      i += digit * w;
      const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
      if (digit < t) break;
      w *= 36 - t;
      k += 36;
    }
    const out = output.length + 1;
    bias = punyAdapt(i - oldi, out, oldi === 0);
    n += Math.floor(i / out);
    i %= out;
    output.splice(i, 0, n);
    i++;
  }
  try {
    return String.fromCodePoint(...output);
  } catch {
    return null;
  }
}

/**
 * Human-friendly group title: take the leading label, decode IDN punycode,
 * capitalise. "github.com" -> "Github", "xn--c1acdymdr…" -> the cyrillic name.
 * IPs and localhost are kept verbatim, port and all ("2ip.ru" is a domain, not an IP).
 */
export function domainToTitle(domain) {
  const bare = domain.replace(/:\d+$/, "");
  if (bare === "localhost" || IP_RE.test(bare)) return domain;
  let label = domain.split(".")[0];
  if (label.startsWith("xn--")) {
    const decoded = decodePunycode(label.slice(4));
    if (decoded) label = decoded;
  }
  return label.charAt(0).toUpperCase() + label.slice(1);
}
