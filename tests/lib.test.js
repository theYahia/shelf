// Unit tests for shelf's pure logic. No browser, no deps — built-in node:test.
// Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";

import { getDomain, domainToColor, domainToTitle, GROUP_COLORS } from "../lib/domain.js";
import { normalizeUrl, findDuplicates, duplicateCount } from "../lib/dedupe.js";
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

test("getDomain: localhost and IPs shelved as-is", () => {
  assert.equal(getDomain("http://localhost:3000/page"), "localhost");
  assert.equal(getDomain("http://192.168.1.1"), "192.168.1.1");
  assert.equal(getDomain("http://127.0.0.1:8080/x"), "127.0.0.1");
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
  assert.equal(domainToTitle("192.168.1.1"), "192.168.1.1");
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
