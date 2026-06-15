// domain.js — the cataloguing system. Turns a URL into a shelf label and a colour.

// A pragmatic (not exhaustive) list of country-code second-level domains, so that
// "shop.example.co.uk" catalogues under "example.co.uk", not "co.uk".
const CC_SLDS = new Set([
  "co.uk", "org.uk", "me.uk", "ac.uk", "gov.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "co.jp", "or.jp", "ne.jp", "ac.jp",
  "com.br", "com.cn", "com.mx", "com.tr", "com.ar",
  "co.in", "co.za", "co.kr", "co.il", "com.sg", "com.hk",
]);

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
  let host;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null; // skip internal/special pages
    host = u.hostname;
  } catch {
    return null;
  }
  if (!host) return null;

  host = host.replace(/^www\./, "");

  // IP addresses and localhost: shelve as-is, no eTLD math.
  if (host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;

  if (!mergeSubdomains) return host; // keep mail.example.com distinct from example.com

  const parts = host.split(".");
  if (parts.length <= 2) return host;

  const lastTwo = parts.slice(-2).join(".");
  const lastThree = parts.slice(-3).join(".");
  // ccSLD like "co.uk" -> keep three labels (example.co.uk); otherwise keep two.
  return CC_SLDS.has(lastTwo) ? lastThree : lastTwo;
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

const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Human-friendly group title: take the leading label, decode IDN punycode,
 * capitalise. "github.com" -> "Github", "xn--c1acdymdr…" -> the cyrillic name.
 * IPs and localhost are kept verbatim ("2ip.ru" is a domain, not an IP).
 */
export function domainToTitle(domain) {
  if (domain === "localhost" || IP_RE.test(domain)) return domain;
  let label = domain.split(".")[0];
  if (label.startsWith("xn--")) {
    const decoded = decodePunycode(label.slice(4));
    if (decoded) label = decoded;
  }
  return label.charAt(0).toUpperCase() + label.slice(1);
}
