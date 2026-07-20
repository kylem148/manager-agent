import { test } from "node:test";
import assert from "node:assert/strict";
import { searchWeb, type SearchResponse } from "./research.js";
import type { ResearchConfig } from "./config.js";

/**
 * Tests for the Exa provider and the provider-neutral recency options. The HTTP
 * layer (global fetch) is stubbed so we can assert exactly what request each
 * provider builds. One live test runs only when EXA_API_KEY is present.
 */

const BASE: ResearchConfig = {
  searchProvider: "auto",
  useJina: true,
  fetchMaxChars: 12000,
};

interface Captured {
  url: string;
  init: RequestInit;
  body: any;
}

/** Install a fetch stub that captures the request and returns `payload` as JSON. */
function stubFetch(payload: unknown, status = 200): { calls: Captured[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : String(input);
    let body: any = undefined;
    if (init.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = String(init.body);
      }
    }
    calls.push({ url, init, body });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => "application/json" },
      json: async () => payload,
      text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
    } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

function header(init: RequestInit, name: string): string | undefined {
  const h = (init.headers ?? {}) as Record<string, string>;
  return h[name];
}

const EXA_SAMPLE = {
  results: [
    { title: "First", url: "https://a.example", text: "full body text" },
    { title: "Second", url: "https://b.example", highlights: ["h1", "h2"] },
  ],
};

test("exa: request shape - url, auth header, query, numResults, contents.text", async () => {
  const { calls, restore } = stubFetch(EXA_SAMPLE);
  try {
    const res = await searchWeb({ ...BASE, exaApiKey: "k-123" }, "semantic query", 4);
    assert.equal(res.provider, "exa");
    assert.equal(calls.length, 1);
    const c = calls[0]!;
    assert.equal(c.url, "https://api.exa.ai/search");
    assert.equal(c.init.method, "POST");
    assert.equal(header(c.init, "x-api-key"), "k-123");
    assert.equal(c.body.query, "semantic query");
    assert.equal(c.body.numResults, 4);
    // contents.text is an object carrying maxCharacters (clamped to Exa's 10000 max).
    assert.equal(c.body.contents.text.maxCharacters, 10000);
  } finally {
    restore();
  }
});

test("exa: maps results, falling back to highlights for snippet", async () => {
  const { restore } = stubFetch(EXA_SAMPLE);
  try {
    const res = await searchWeb({ ...BASE, exaApiKey: "k" }, "q", 6);
    assert.deepEqual(res.results, [
      { title: "First", url: "https://a.example", snippet: "full body text" },
      { title: "Second", url: "https://b.example", snippet: "h1 … h2" },
    ]);
  } finally {
    restore();
  }
});

test("exa: publishedWithinDays maps to startPublishedDate (ISO 8601, recent)", async () => {
  const { calls, restore } = stubFetch(EXA_SAMPLE);
  try {
    await searchWeb({ ...BASE, exaApiKey: "k" }, "latest thing", 6, { publishedWithinDays: 30 });
    const start = calls[0]!.body.startPublishedDate;
    assert.ok(typeof start === "string", "startPublishedDate should be set");
    // Valid ISO 8601 and roughly 30 days in the past.
    const parsed = Date.parse(start);
    assert.ok(Number.isFinite(parsed), "startPublishedDate should parse");
    const ageDays = (Date.now() - parsed) / (24 * 60 * 60 * 1000);
    assert.ok(ageDays > 29 && ageDays < 31, `expected ~30 days, got ${ageDays}`);
  } finally {
    restore();
  }
});

test("exa: no publishedWithinDays => no startPublishedDate (full timeline)", async () => {
  const { calls, restore } = stubFetch(EXA_SAMPLE);
  try {
    await searchWeb({ ...BASE, exaApiKey: "k" }, "historical prior art", 6);
    assert.equal(calls[0]!.body.startPublishedDate, undefined);
  } finally {
    restore();
  }
});

test("exa: freshContent maps to contents.maxAgeHours=0; omitted otherwise", async () => {
  {
    const { calls, restore } = stubFetch(EXA_SAMPLE);
    try {
      await searchWeb({ ...BASE, exaApiKey: "k" }, "q", 6, { freshContent: true });
      assert.equal(calls[0]!.body.contents.maxAgeHours, 0);
    } finally {
      restore();
    }
  }
  {
    const { calls, restore } = stubFetch(EXA_SAMPLE);
    try {
      await searchWeb({ ...BASE, exaApiKey: "k" }, "q", 6);
      assert.equal("maxAgeHours" in calls[0]!.body.contents, false);
    } finally {
      restore();
    }
  }
});

test("auto mode prefers exa when EXA_API_KEY is present", async () => {
  const { calls, restore } = stubFetch(EXA_SAMPLE);
  try {
    const res = await searchWeb(
      { ...BASE, searchProvider: "auto", exaApiKey: "k", braveApiKey: "b", tavilyApiKey: "t" },
      "q",
      6,
    );
    assert.equal(res.provider, "exa");
    assert.equal(calls[0]!.url, "https://api.exa.ai/search");
  } finally {
    restore();
  }
});

test("explicit exa without key degrades gracefully to 'none' (no throw)", async () => {
  const { calls, restore } = stubFetch(EXA_SAMPLE);
  try {
    const res = await searchWeb({ ...BASE, searchProvider: "exa" }, "q", 6);
    assert.equal(res.provider, "none");
    assert.equal(res.results.length, 0);
    assert.match(res.note ?? "", /not configured|EXA_API_KEY/i);
    assert.equal(calls.length, 0, "should not hit the network with no key");
  } finally {
    restore();
  }
});

test("no provider configured returns structured 'not configured' note", async () => {
  const { calls, restore } = stubFetch(EXA_SAMPLE);
  try {
    const res = await searchWeb({ ...BASE }, "q", 6);
    assert.equal(res.provider, "none");
    assert.ok(res.note && res.note.includes("EXA_API_KEY"));
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test("brave: publishedWithinDays maps to a freshness date range; freshContent ignored", async () => {
  const { calls, restore } = stubFetch({ web: { results: [] } });
  try {
    await searchWeb({ ...BASE, searchProvider: "brave", braveApiKey: "b" }, "q", 6, {
      publishedWithinDays: 7,
      freshContent: true,
    });
    const u = new URL(calls[0]!.url);
    const freshness = u.searchParams.get("freshness");
    assert.ok(freshness, "brave should set a freshness param");
    // Shape is YYYY-MM-DDtoYYYY-MM-DD.
    assert.match(freshness!, /^\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2}$/);
  } finally {
    restore();
  }
});

test("tavily: publishedWithinDays maps to `days`; brave/tavily unaffected without options", async () => {
  {
    const { calls, restore } = stubFetch({ results: [] });
    try {
      await searchWeb({ ...BASE, searchProvider: "tavily", tavilyApiKey: "t" }, "q", 6, {
        publishedWithinDays: 14,
      });
      assert.equal(calls[0]!.body.days, 14);
    } finally {
      restore();
    }
  }
  {
    const { calls, restore } = stubFetch({ results: [] });
    try {
      await searchWeb({ ...BASE, searchProvider: "tavily", tavilyApiKey: "t" }, "q", 6);
      assert.equal("days" in calls[0]!.body, false);
    } finally {
      restore();
    }
  }
});

// Live test: only runs when a real key is present. Confirms the request shape
// is accepted by the actual Exa API.
test(
  "exa: live API accepts the request (requires EXA_API_KEY)",
  { skip: process.env.EXA_API_KEY ? false : "EXA_API_KEY not set" },
  async () => {
    const res: SearchResponse = await searchWeb(
      { ...BASE, searchProvider: "exa", exaApiKey: process.env.EXA_API_KEY },
      "latest TypeScript release notes",
      3,
      { publishedWithinDays: 180, freshContent: false },
    );
    assert.equal(res.provider, "exa");
    assert.equal(res.note, undefined, `unexpected error note: ${res.note}`);
    assert.ok(res.results.length > 0, "expected at least one live result");
    for (const r of res.results) {
      assert.ok(r.url.startsWith("http"), `bad url: ${r.url}`);
    }
  },
);
