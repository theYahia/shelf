// Unit tests for shelf's pure logic. No browser, no deps — built-in node:test.
// Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";

import { getDomain, domainToColor, domainToTitle, isExcepted, GROUP_COLORS } from "../lib/domain.js";
import {
  normalizeUrl,
  findDuplicates,
  duplicateCount,
  redundantTabs,
  dedupeOptions,
} from "../lib/dedupe.js";
import { matchRule, computeAssignments } from "../lib/grouping.js";

// --- domain.js -------------------------------------------------------------

test("getDomain: plain domain + www stripping", () => {
  assert.equal(getDomain("https://github.com/u/repo"), "github.com");
  assert.equal(getDomain("https://www.github.com"), "github.com");
});

test("getDomain: subdomain merged by default", () => {
  assert.equal(getDomain("https://api.github.com"), "github.com");
  assert.equal(getDomain("https://mail.example.com"), "example.com");
});

test("getDomain: ccSLD kept as eTLD+1", () => {
  assert.equal(getDomain("https://shop.example.co.uk"), "example.co.uk");
  assert.equal(getDomain("https://example.co.uk"), "example.co.uk");
  assert.equal(getDomain("https://api.example.com.br"), "example.com.br");
  assert.equal(getDomain("https://sub.example.co.jp"), "example.co.jp");
});

test("getDomain: localhost and IPs shelved as-is, port and all", () => {
  // Two dev servers are two projects — they don't belong on one shelf.
  assert.equal(getDomain("http://localhost:3000/page"), "localhost:3000");
  assert.notEqual(getDomain("http://localhost:3000/"), getDomain("http://localhost:8080/"));
  assert.equal(getDomain("http://localhost/page"), "localhost");
  assert.equal(getDomain("http://192.168.1.1"), "192.168.1.1");
  assert.equal(getDomain("http://127.0.0.1:8080/x"), "127.0.0.1:8080");
});

test("getDomain: hosting suffixes keep the label that identifies the site", () => {
  assert.equal(getDomain("https://alice.github.io/blog"), "alice.github.io");
  assert.notEqual(getDomain("https://alice.github.io"), getDomain("https://bob.github.io"));
  assert.equal(getDomain("https://my-app.vercel.app"), "my-app.vercel.app");
  assert.equal(getDomain("https://shop.myshopify.com"), "shop.myshopify.com");
  assert.equal(getDomain("https://bucket.s3.amazonaws.com/k"), "bucket.s3.amazonaws.com");
  // The suffix on its own is still just a host.
  assert.equal(getDomain("https://github.io"), "github.io");
});

test("getDomain: ccSLDs beyond the original handful", () => {
  assert.equal(getDomain("https://shop.example.com.ua"), "example.com.ua");
  assert.equal(getDomain("https://a.example.co.id"), "example.co.id");
  assert.equal(getDomain("https://a.example.com.pl"), "example.com.pl");
});

test("isExcepted: covers subdomains, respects ports, ignores an empty list", () => {
  const set = (...d) => new Set(d);
  assert.equal(isExcepted("https://mail.google.com/x", set("google.com")), true);
  assert.equal(isExcepted("https://google.com", set("google.com")), true);
  assert.equal(isExcepted("https://www.google.com", set("google.com")), true);
  assert.equal(isExcepted("https://notgoogle.com", set("google.com")), false);
  assert.equal(isExcepted("http://localhost:3000", set("localhost:3000")), true);
  assert.equal(isExcepted("http://localhost:3000", set("localhost")), true);
  assert.equal(isExcepted("http://localhost:8080", set("localhost:3000")), false);
  assert.equal(isExcepted("https://example.com", set()), false);
  // A bare TLD is a typo, not a wildcard — it must not empty the whole browser.
  assert.equal(isExcepted("https://example.com", set("com")), false);
});

test("getDomain: null for non-http(s) and invalid URLs", () => {
  assert.equal(getDomain("chrome://extensions"), null);
  assert.equal(getDomain("brave://settings"), null);
  assert.equal(getDomain("file:///c/x"), null);
  assert.equal(getDomain("about:blank"), null);
  assert.equal(getDomain("not a url"), null);
});

test("getDomain: mergeSubdomains=false keeps full host", () => {
  assert.equal(getDomain("https://api.github.com", { mergeSubdomains: false }), "api.github.com");
  assert.equal(getDomain("https://mail.example.co.uk", { mergeSubdomains: false }), "mail.example.co.uk");
});

test("domainToColor: deterministic and within palette", () => {
  assert.equal(domainToColor("github.com"), domainToColor("github.com"));
  for (const d of ["github.com", "youtube.com", "example.org", "a.b.c"]) {
    assert.ok(GROUP_COLORS.includes(domainToColor(d)));
  }
});

test("domainToTitle: capitalised label, raw for localhost/IP", () => {
  assert.equal(domainToTitle("github.com"), "Github");
  assert.equal(domainToTitle("example.co.uk"), "Example");
  assert.equal(domainToTitle("localhost"), "localhost");
  assert.equal(domainToTitle("localhost:3000"), "localhost:3000");
  assert.equal(domainToTitle("192.168.1.1"), "192.168.1.1");
  assert.equal(domainToTitle("127.0.0.1:8080"), "127.0.0.1:8080");
});

test("domainToTitle: digit-leading domain is not treated as an IP", () => {
  assert.equal(domainToTitle("2ip.ru"), "2ip");
});

test("domainToTitle: punycode IDN labels are decoded", () => {
  assert.equal(domainToTitle("xn--bcher-kva.de"), "Bücher");
  // a real .рф domain should not surface as raw "Xn--…"
  assert.ok(!domainToTitle("xn--c1acdymdr.xn--p1ai").startsWith("Xn--"));
});

// --- dedupe.js -------------------------------------------------------------

test("normalizeUrl: fragment ignored by default, query kept", () => {
  assert.equal(
    normalizeUrl("https://example.com/p#a"),
    normalizeUrl("https://example.com/p#b")
  );
  assert.notEqual(
    normalizeUrl("https://example.com/p?x=1"),
    normalizeUrl("https://example.com/p?x=2")
  );
});

test("normalizeUrl: ignoreQuery collapses query strings", () => {
  assert.equal(
    normalizeUrl("https://example.com/p?x=1", { ignoreQuery: true }),
    normalizeUrl("https://example.com/p?x=2", { ignoreQuery: true })
  );
});

test("normalizeUrl: root trailing slash normalised, subpath preserved", () => {
  assert.equal(normalizeUrl("https://example.com/"), normalizeUrl("https://example.com"));
  assert.ok(normalizeUrl("https://example.com/docs/").endsWith("/docs/"));
});

test("normalizeUrl: invalid URL returned as-is", () => {
  assert.equal(normalizeUrl("not a url"), "not a url");
});

test("normalizeUrl: #/ and #! are routes, not anchors — never merged away", () => {
  assert.notEqual(
    normalizeUrl("https://app.example.com/#/inbox"),
    normalizeUrl("https://app.example.com/#/billing")
  );
  assert.notEqual(
    normalizeUrl("https://app.example.com/#!/a"),
    normalizeUrl("https://app.example.com/#!/b")
  );
  // A plain anchor is still noise.
  assert.equal(
    normalizeUrl("https://example.com/doc#intro"),
    normalizeUrl("https://example.com/doc#summary")
  );
});

test("dedupeOptions: strict mode ignores the user's looser settings", () => {
  const loose = { dedupeIgnoreFragment: true, dedupeIgnoreQuery: true };
  assert.deepEqual(dedupeOptions(loose, { strict: true }), {
    ignoreFragment: false,
    ignoreQuery: false,
  });
  assert.deepEqual(dedupeOptions(loose), { ignoreFragment: true, ignoreQuery: true });
});

test("findDuplicates: only real pages — two chrome://newtab are not duplicates", () => {
  assert.equal(
    findDuplicates([
      { id: 1, url: "chrome://newtab/" },
      { id: 2, url: "chrome://newtab/" },
      { id: 3, url: "about:blank" },
      { id: 4, url: "about:blank" },
      { id: 5, url: "file:///c/x" },
      { id: 6, url: "file:///c/x" },
    ]).length,
    0
  );
});

test("findDuplicates: a pinned copy is the keeper, and is never counted as redundant", () => {
  const groups = findDuplicates([
    { id: 1, url: "https://example.com/p" },
    { id: 2, url: "https://example.com/p", pinned: true },
    { id: 3, url: "https://example.com/p" },
  ]);
  assert.equal(groups[0].tabs[0].id, 2, "pinned sorts first, so slice(1) never takes it");
  assert.deepEqual(redundantTabs(groups).map((t) => t.id), [1, 3]);
  assert.equal(duplicateCount(groups), 2);

  // Two pinned copies: nothing is closable, so the badge must not sit on a number.
  const bothPinned = findDuplicates([
    { id: 1, url: "https://example.com/p", pinned: true },
    { id: 2, url: "https://example.com/p", pinned: true },
  ]);
  assert.equal(duplicateCount(bothPinned), 0);
});

test("findDuplicates: groups, sorts by id, ignores urlless tabs", () => {
  assert.equal(findDuplicates([
    { id: 1, url: "https://github.com" },
    { id: 2, url: "https://youtube.com" },
  ]).length, 0);

  const dup = findDuplicates([
    { id: 5, url: "https://example.com" },
    { id: 2, url: "https://example.com" },
    { id: 8, url: "https://other.com" },
  ]);
  assert.equal(dup.length, 1);
  assert.deepEqual(dup[0].tabs.map((t) => t.id), [2, 5]);

  const withNull = findDuplicates([
    { id: 1, url: "https://github.com" },
    { id: 2, url: undefined },
    { id: 3, url: "https://github.com" },
  ]);
  assert.equal(withNull.length, 1);
  assert.equal(withNull[0].tabs.length, 2);
});

test("duplicateCount: redundant tabs (group size minus one)", () => {
  assert.equal(duplicateCount([{ tabs: [{}, {}, {}] }, { tabs: [{}, {}] }]), 3);
  assert.equal(duplicateCount([]), 0);
});

test("dedupeOptions: maps settings keys onto normalizeUrl option keys", () => {
  assert.deepEqual(
    dedupeOptions({ dedupeIgnoreFragment: true, dedupeIgnoreQuery: false }),
    { ignoreFragment: true, ignoreQuery: false }
  );
});

// --- grouping.js: matchRule ------------------------------------------------

test("matchRule: exact, subdomain, case-insensitive, substring, null", () => {
  const rules = [{ match: "github.com", name: "Code", color: "blue" }];
  assert.equal(matchRule("https://github.com/u", rules).name, "Code");
  assert.equal(matchRule("https://api.github.com", rules).name, "Code");

  assert.ok(matchRule("https://github.com", [{ match: "GitHub.com", name: "Code" }]));
  assert.ok(matchRule("https://youtube.com/watch?v=x", [{ match: "youtube", name: "Video" }]));
  assert.equal(matchRule("https://example.com", rules), null);
});

test("matchRule: rules without a match field are skipped", () => {
  assert.equal(matchRule("https://github.com", [{ name: "x" }]), null);
});

test("CRIT-6: a short rule no longer swallows the browser", () => {
  // "co" used to match every .com through host.includes(m).
  assert.equal(matchRule("https://github.com", [{ match: "co", name: "X" }]), null);
  assert.equal(matchRule("https://example.com", [{ match: "com", name: "X" }]), null);
  // ...but a whole label still matches.
  assert.ok(matchRule("https://co.uk.example.com", [{ match: "co", name: "X" }]));
});

test("CRIT-6: a domain rule matches the host, not the address bar", () => {
  const rules = [{ match: "github.com", name: "Code" }];
  assert.equal(matchRule("https://evil.example.com/?ref=github.com", rules), null);
  assert.ok(matchRule("https://github.com/x", rules));
  assert.ok(matchRule("https://api.github.com/x", rules));
});

test("matchRule: a slash means the user is aiming at a path", () => {
  const rules = [{ match: "github.com/issues", name: "Bugs" }];
  assert.ok(matchRule("https://github.com/issues/42", rules));
  assert.ok(matchRule("https://GITHUB.com/ISSUES/42", rules), "case-insensitive both ways");
  assert.equal(matchRule("https://github.com/pulls", rules), null);
});

// --- grouping.js: computeAssignments respects manual groups -----------------

test("computeAssignments: only ungrouped (loose) tabs are shelved", async () => {
  const settings = { mergeSubdomains: true, exceptions: [], rules: [] };
  const res = await computeAssignments(
    [
      { id: 1, url: "https://github.com", groupId: -1 }, // loose
      { id: 2, url: "https://github.com", groupId: 7 },  // already grouped by hand
      { id: 3, url: "https://youtube.com" },             // no groupId field -> loose
    ],
    settings
  );
  assert.ok(res.has(1), "loose tab is shelved");
  assert.ok(!res.has(2), "manually grouped tab is left alone");
  assert.ok(res.has(3), "tab without groupId is treated as loose");
});

test("computeAssignments: shelves are keyed by domain, so lookalike titles stay apart", async () => {
  const res = await computeAssignments(
    [
      { id: 1, url: "https://github.com", groupId: -1 },
      { id: 2, url: "https://alice.github.io", groupId: -1 },
      { id: 3, url: "https://example.org", groupId: -1 },
      { id: 4, url: "https://example.com", groupId: -1 },
    ],
    { mergeSubdomains: true, exceptions: [], rules: [] }
  );
  const keys = [...res.values()].map((s) => s.key);
  assert.equal(new Set(keys).size, 4, "four sites, four keys");
  // example.com and example.org are the real collision: one title, two shelves.
  assert.equal(res.get(3).title, res.get(4).title);
  assert.notEqual(res.get(3).key, res.get(4).key);
});

test("MED-10: an exception is applied before any rule can claim the tab", async () => {
  const settings = {
    mergeSubdomains: true,
    exceptions: ["google.com"],
    rules: [{ match: "google.com", name: "Mail", color: "red" }],
  };
  const res = await computeAssignments(
    [
      { id: 1, url: "https://mail.google.com", groupId: -1 },
      { id: 2, url: "https://github.com", groupId: -1 },
    ],
    settings
  );
  assert.ok(!res.has(1), "the rule does not override the exception");
  assert.ok(res.has(2));
});
