import type { ResearchConfig } from "./config.js";

/**
 * Research layer. Two independent pieces behind small interfaces so either can
 * be swapped or extended:
 *
 *   SearchProvider  — query -> candidate results (title, url, snippet)
 *   Fetcher         — url   -> clean text (markdown)
 *
 * The model (via tools) drives the protocol; this module just does the I/O.
 * Everything is optional: with no search credentials configured, search_web
 * returns a clear "not configured" message rather than throwing, and the model
 * can still fetch_url any link the user provides.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  provider: string;
  results: SearchResult[];
  note?: string;
}

/**
 * Provider-neutral recency controls the model sets per call. Kept deliberately
 * free of any provider's native parameter names; each provider translates these
 * to its own shape (or ignores what it can't express).
 *
 *   publishedWithinDays — constrain the result POOL to content published within
 *     the last N days. The lever for "latest / current" queries. Omit to search
 *     the full timeline (historical / conceptual / prior-art queries).
 *   freshContent — when the provider returns inline page content, fetch it live
 *     instead of from cache. Independent of the pool filter above.
 */
export interface SearchOptions {
  publishedWithinDays?: number;
  freshContent?: boolean;
}

export interface FetchResponse {
  url: string;
  text: string;
  truncated: boolean;
  note?: string;
}

const UA = "comanager/1.0 (+research)";

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 20000,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// --- Search providers ---------------------------------------------------------

function resolveProvider(cfg: ResearchConfig): "exa" | "brave" | "tavily" | "searxng" | "none" {
  if (cfg.searchProvider === "none") return "none";
  if (cfg.searchProvider === "exa") return cfg.exaApiKey ? "exa" : "none";
  if (cfg.searchProvider === "brave") return cfg.braveApiKey ? "brave" : "none";
  if (cfg.searchProvider === "tavily") return cfg.tavilyApiKey ? "tavily" : "none";
  if (cfg.searchProvider === "searxng") return cfg.searxngUrl ? "searxng" : "none";
  // auto: prefer whichever is configured, in a sensible order.
  if (cfg.exaApiKey) return "exa";
  if (cfg.braveApiKey) return "brave";
  if (cfg.tavilyApiKey) return "tavily";
  if (cfg.searxngUrl) return "searxng";
  return "none";
}

export function describeSearch(cfg: ResearchConfig): string {
  const p = resolveProvider(cfg);
  if (p === "none") {
    return "search: not configured (set EXA_API_KEY, BRAVE_API_KEY, TAVILY_API_KEY, or SEARXNG_URL)";
  }
  return `search: ${p}`;
}

export async function searchWeb(
  cfg: ResearchConfig,
  query: string,
  count = 6,
  options: SearchOptions = {},
): Promise<SearchResponse> {
  const provider = resolveProvider(cfg);
  switch (provider) {
    case "exa":
      return exaSearch(cfg.exaApiKey!, query, count, options, cfg.fetchMaxChars);
    case "brave":
      return braveSearch(cfg.braveApiKey!, query, count, options);
    case "tavily":
      return tavilySearch(cfg.tavilyApiKey!, query, count, options);
    case "searxng":
      return searxngSearch(cfg.searxngUrl!, query, count);
    default:
      return {
        provider: "none",
        results: [],
        note: "No search provider configured. Set EXA_API_KEY, BRAVE_API_KEY, TAVILY_API_KEY, or SEARXNG_URL. You can still fetch_url a specific link.",
      };
  }
}

/**
 * Turn a provider-neutral publishedWithinDays into an ISO 8601 timestamp for
 * the start of the recency window. Returns undefined when no/invalid window is
 * requested. Kept free of Date.now() indirection so it is easy to reason about.
 */
function startPublishedDate(days: number | undefined): string | undefined {
  if (days === undefined || !Number.isFinite(days) || days <= 0) return undefined;
  const ms = Date.now() - days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

/**
 * Exa semantic search with inline contents. Translates the neutral SearchOptions
 * fully to Exa's native params:
 *   publishedWithinDays -> startPublishedDate (ISO 8601), constraining the pool
 *   freshContent        -> contents.maxAgeHours = 0 (live crawl, not cache)
 * When freshContent is not set we omit maxAgeHours entirely, letting Exa use its
 * default fallback fetching. `livecrawl` is deprecated and intentionally unused.
 */
async function exaSearch(
  key: string,
  query: string,
  count: number,
  options: SearchOptions,
  maxChars: number,
): Promise<SearchResponse> {
  const contents: Record<string, unknown> = {
    text: { maxCharacters: Math.min(Math.max(maxChars, 1), 10000) },
  };
  if (options.freshContent) contents.maxAgeHours = 0;

  const body: Record<string, unknown> = {
    query,
    numResults: Math.min(count, 100),
    contents,
  };
  const start = startPublishedDate(options.publishedWithinDays);
  if (start) body.startPublishedDate = start;

  const res = await fetchWithTimeout("https://api.exa.ai/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "User-Agent": UA },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return { provider: "exa", results: [], note: `Exa API error ${res.status}: ${await safeText(res)}` };
  }
  const data = (await res.json()) as {
    results?: { title?: string; url?: string; text?: string; highlights?: string[] }[];
  };
  const results = (data.results ?? []).slice(0, count).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    // Prefer inline page text; fall back to concatenated highlights.
    snippet: (r.text ?? r.highlights?.join(" … ") ?? "").trim(),
  }));
  return { provider: "exa", results };
}

async function braveSearch(
  key: string,
  query: string,
  count: number,
  options: SearchOptions,
): Promise<SearchResponse> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(count, 20)));
  // Brave's native time filter is `freshness`; a date range clamps the pool to
  // recently-published content. freshContent has no Brave equivalent (ignored).
  const start = startPublishedDate(options.publishedWithinDays);
  if (start) {
    const from = start.slice(0, 10);
    const to = new Date(Date.now()).toISOString().slice(0, 10);
    url.searchParams.set("freshness", `${from}to${to}`);
  }
  const res = await fetchWithTimeout(url.toString(), {
    headers: { Accept: "application/json", "X-Subscription-Token": key, "User-Agent": UA },
  });
  if (!res.ok) {
    return { provider: "brave", results: [], note: `Brave API error ${res.status}: ${await safeText(res)}` };
  }
  const data = (await res.json()) as {
    web?: { results?: { title?: string; url?: string; description?: string }[] };
  };
  const results = (data.web?.results ?? []).slice(0, count).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: stripTags(r.description ?? ""),
  }));
  return { provider: "brave", results };
}

async function tavilySearch(
  key: string,
  query: string,
  count: number,
  options: SearchOptions,
): Promise<SearchResponse> {
  const payload: Record<string, unknown> = {
    api_key: key,
    query,
    max_results: Math.min(count, 20),
    search_depth: "basic",
  };
  // Tavily's native recency lever is `days` (published within the last N days).
  // freshContent has no Tavily equivalent and is ignored.
  const days = options.publishedWithinDays;
  if (days !== undefined && Number.isFinite(days) && days > 0) {
    payload.days = Math.ceil(days);
  }
  const res = await fetchWithTimeout("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    return { provider: "tavily", results: [], note: `Tavily API error ${res.status}: ${await safeText(res)}` };
  }
  const data = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
  };
  const results = (data.results ?? []).slice(0, count).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
  }));
  return { provider: "tavily", results };
}

async function searxngSearch(base: string, query: string, count: number): Promise<SearchResponse> {
  const url = new URL("/search", base);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  const res = await fetchWithTimeout(url.toString(), {
    headers: { Accept: "application/json", "User-Agent": UA },
  });
  if (!res.ok) {
    return { provider: "searxng", results: [], note: `SearXNG error ${res.status}: ${await safeText(res)}` };
  }
  const data = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
  };
  const results = (data.results ?? []).slice(0, count).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
  }));
  return { provider: "searxng", results };
}

// --- Fetcher ------------------------------------------------------------------

/**
 * Fetch a URL as clean text. Default path is Jina Reader (https://r.jina.ai/),
 * which renders a page to markdown with no API key required. Falls back to a
 * plain HTTP GET with light HTML stripping if Jina is disabled or fails.
 */
export async function fetchUrl(cfg: ResearchConfig, target: string): Promise<FetchResponse> {
  let normalized: string;
  try {
    normalized = new URL(target).toString();
  } catch {
    return { url: target, text: "", truncated: false, note: `Invalid URL: ${target}` };
  }
  if (!/^https?:$/.test(new URL(normalized).protocol)) {
    return { url: normalized, text: "", truncated: false, note: "Only http(s) URLs are supported." };
  }

  if (cfg.useJina) {
    const viaJina = await fetchViaJina(cfg, normalized);
    if (viaJina) return clip(viaJina, cfg.fetchMaxChars);
  }
  const direct = await fetchDirect(normalized);
  return clip(direct, cfg.fetchMaxChars);
}

async function fetchViaJina(cfg: ResearchConfig, url: string): Promise<FetchResponse | null> {
  const jinaUrl = "https://r.jina.ai/" + url;
  const headers: Record<string, string> = { "User-Agent": UA, Accept: "text/plain" };
  if (cfg.jinaApiKey) headers.Authorization = `Bearer ${cfg.jinaApiKey}`;
  try {
    const res = await fetchWithTimeout(jinaUrl, { headers });
    if (!res.ok) return null;
    const text = await res.text();
    return { url, text, truncated: false };
  } catch {
    return null;
  }
}

async function fetchDirect(url: string): Promise<FetchResponse> {
  try {
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": UA } });
    if (!res.ok) {
      return { url, text: "", truncated: false, note: `HTTP ${res.status} fetching ${url}` };
    }
    const ct = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    const text = ct.includes("html") ? htmlToText(raw) : raw;
    return { url, text, truncated: false };
  } catch (e) {
    return { url, text: "", truncated: false, note: `Fetch failed: ${(e as Error).message}` };
  }
}

// --- helpers ------------------------------------------------------------------

function clip(r: FetchResponse, max: number): FetchResponse {
  if (r.text.length <= max) return r;
  return { ...r, text: r.text.slice(0, max), truncated: true };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

/** Very light HTML -> text. The Jina path is preferred; this is a fallback. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
