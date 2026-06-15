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

/**
 * Human-friendly group title from a domain: drop the public suffix, capitalise.
 * "github.com" -> "github", "example.co.uk" -> "example".
 */
export function domainToTitle(domain) {
  if (domain === "localhost" || /^\d/.test(domain)) return domain;
  const label = domain.split(".")[0];
  return label.charAt(0).toUpperCase() + label.slice(1);
}
