# Cost audit and model options — July 2026

**All prices in this report are point-in-time and were read on 2026-07-29.** Pricing
pages rot; re-read every rate before acting on anything here. Sources and access
dates are cited inline.

## Key findings

1. **The meter overstates the bill by 20%.** `src/cost.ts` derives Bedrock rates as
   1.2x Anthropic's list. AWS Marketplace publishes the Opus-tier Bedrock rates as
   **$5.00 / $25.00 / $6.25 (5m write) / $10.00 (1h write) / $0.50 (read)** per
   MTok — identical to first-party, not 1.2x. Real spend for the measured window is
   **$62.46**, not the $74.96 `/cost` would print.
2. **The input side is 74% of the bill, not output.** Measured over 194 real turns:
   cache write 40.9%, cache read 33.4%, output 25.7%, uncached input 0.006%.
3. **Caching is working, and that is measured, not assumed.** 690 uncached input
   tokens across 194 turns (3.6/turn). Read:write ratio 16.3:1.
4. **The 1-hour cache TTL is already shipped** (`CACHE_TTL = "1h"` in `model.ts`)
   and is now formally documented as supported for Opus 5 on Bedrock. The brief's
   premise that it is "deliberately NOT used" is stale.
5. **The 1h TTL is being paid on the wrong breakpoints.** 92.4% of measured turn
   boundaries are under 5 minutes; 1.1% exceed an hour. The 2x write premium is
   charged on 100% of writes to defend ~7% of turns.
6. **Nothing trims message history.** `state.messages` grows monotonically for the
   life of a session. Measured cache reads are 215,335 tokens per turn.
7. **The model in use is `us.anthropic.claude-opus-5`, not Opus 4.8** (set in
   `~/co-managers/.env`; confirmed by both cost ledgers). The brief and the repo's
   own docs are one model behind.

---

## 1. Where the money goes

### 1.1 The measured baseline

Read from the two live cost ledgers (`~/co-managers/instances/*/.cost.json`) — this
is `from existing instrumentation`, written by `CostLedger.record` after every turn.
Window: 2026-07-27T21:36Z to 2026-07-29T18:44Z.

| | gav-lib | testing | total |
| --- | ---: | ---: | ---: |
| uncached input | 322 | 368 | 690 |
| cache write | 1,370,679 | 1,184,327 | 2,555,006 |
| cache read | 23,010,004 | 18,765,011 | 41,775,015 |
| output | 293,434 | 347,463 | 640,897 |
| turns | 90 | 104 | 194 |
| model wall-clock | 76m 34s | 93m 01s | 2h 49m |

Priced at the AWS Marketplace Opus-tier rates (§5.1), with writes at the 1h rate the
app actually sends:

| class | tokens | rate /MTok | cost | share |
| --- | ---: | ---: | ---: | ---: |
| cache write (1h) | 2,555,006 | $10.00 | **$25.55** | 40.9% |
| cache read | 41,775,015 | $0.50 | **$20.89** | 33.4% |
| output | 640,897 | $25.00 | **$16.02** | 25.7% |
| uncached input | 690 | $5.00 | $0.003 | 0.006% |
| **total** | | | **$62.46** | |

`measured` for the token counts; `statically counted` for the arithmetic;
`from published rates` for the prices.

Derived: **$0.322 per turn**, 52.4s of model wall-clock per turn, ~$32 per active
day at the observed intensity. A 30-active-day month extrapolates to roughly $970 —
`estimated`, from a 1.9-day sample of two instances, and the sample is small enough
that this figure should be treated as an order of magnitude.

### 1.2 Token budget per turn type

Round counts per turn are **not recorded anywhere**, so the per-type splits below are
`estimated` from the measured aggregate plus the code path. `maxToolRounds` defaults
to 12 (`model.ts`); measured output of 3,304 tokens/turn is consistent with 2–4
rounds averaging 800–1,600 output tokens each. Where a figure depends on the round
count I give the band rather than a single number.

Let **P** = fixed prefix ≈ 22–25k tokens (§2), **H** = message history at that point.

**Cold session start.** `buildSystemPrompt` runs once; the greeting turn
(`runOpeningGreeting`) is one round at `effort: "low"`, no tools.
- Writes the whole prefix: P × $10/MTok ≈ **$0.22–0.25**.
- Output: a 2–4 sentence greeting, ~200–400 tokens ≈ $0.01.
- **≈ $0.25.** Provenance: prefix bytes `statically counted`, tokens `estimated`,
  rate published.

**Ordinary conversational turn.** One round, no tools.
- Read P + H. At H = 40k: 64k × $0.50/MTok = $0.032.
- Write the turn's delta (user message + assistant message), ~1–2k tokens ≈ $0.015.
- Output ~1.5k tokens ≈ $0.038.
- **≈ $0.085.** `estimated`.

**Tool-heavy research turn.** This is the type the measured average is made of: each
round re-sends the whole prefix plus everything before it, and `search_web` /
`fetch_url` results (capped at `CO_FETCH_MAX_CHARS`, default 12,000 chars each) land
permanently in history.
- Reads dominate: at the measured 215,335 read tokens/turn → $0.108.
- Writes 13,170 tokens/turn → $0.132.
- Output 3,304 tokens → $0.083.
- **≈ $0.32**, i.e. the measured all-turn average is essentially this turn type.
  `measured` aggregate, `estimated` attribution.

**Crew-report review turn.** `drainReviews` pushes one user message containing a
~1.4 KB preamble plus the run record from `resolveReviewRecord`. The record is the
run context, capped at `REVIEW_CONTEXT_MAX = 16,000` chars, **plus the crew's final
report whole and unbounded** (a deliberate, documented decision in
`crewtranscript.ts`).

Measured across 92 real Stop-hook sidecars in `~/co-managers/instances/*/.dispatch/captures/*.stop.json`:

| crew final report | bytes | ≈ tokens at 3.7 B/tok |
| --- | ---: | ---: |
| min | 119 | 32 |
| median | 3,226 | 872 |
| mean | 5,746 | 1,553 |
| p90 | 13,926 | 3,764 |
| max | 49,111 | 13,273 |

So the injected block is ~19 KB (≈5.2k tokens) at the median and ~65 KB (≈17.6k
tokens) at the observed maximum. One-off write cost $0.05–$0.18. **The one-off is
not the problem** — the block joins `state.messages` and is re-read on every
subsequent round for the rest of the session. At 5.2k tokens and 40 remaining
rounds that is another $0.10; at the p90 size, $0.30.

**End-of-session distillation.** `endOfSessionGuard` → `syncActiveContext(force,
quiet)` runs unconditionally whenever `userTurns > 0`. One turn at the session
effort with the full accumulated history in context, producing a whole rewritten
`activeContext.md`.
- Read P + H_final. At H = 80k: 104k × $0.50/MTok = $0.052.
- Output: measured `activeContext.md` sizes are 7,537 B (gav-lib) and 10,488 B
  (testing) → ~2.0–2.8k tokens ≈ $0.050–$0.070.
- **≈ $0.10–$0.12 per session.** Across the 24 sessions in the window, ~$2.6, i.e.
  ~4% of the bill. `estimated` from `statically counted` file sizes.

---

## 2. Static prefix inventory

Method: imported `buildSystemPrompt` and `toolDefinitions` from `src/` with `tsx`,
built the real prompt against a throwaway instance and against both live instances,
and split on the `\n\n---\n\n` separator. No source file was modified. All byte
counts below are **`statically counted`** and exact; token figures are
**`estimated`** at 3.6–3.9 bytes/token (a markdown-and-JSON mix tokenizes denser
than the ~4 B/tok rule of thumb, and Opus 4.7+ uses a tokenizer that produces
~30% more tokens for the same text than the previous one — see §5.4).

### 2.1 Ranked, biggest first (linked instance `testing`)

| block | bytes | share of prefix | owner |
| --- | ---: | ---: | --- |
| Live state block | 31,292 | 34.7% | captain's content |
| Tool definitions (JSON wire form, 22 tools) | 23,017 | 25.5% | code |
| Dispatch protocol | 15,398 | 17.1% | code |
| How you operate | 4,674 | 5.2% | code |
| Orders protocol | 2,701 | 3.0% | code |
| Reviewing implementation reports | 2,585 | 2.9% | code |
| Identity + constraints | 2,457 | 2.7% | code |
| Task table protocol | 2,450 | 2.7% | code |
| Documents protocol | 1,696 | 1.9% | code |
| Research protocol | 1,389 | 1.5% | code |
| Memory protocol | 1,381 | 1.5% | code |
| Voice: the navigator | 713 | 0.8% | code |
| Environment | 200 | 0.2% | code |
| Recent conversation tail | 211 | 0.2% | data (cap 8,000 chars) |
| separators (12 × 7 B) | 84 | 0.1% | code |
| **fixed prefix total** | **90,248** | | |

Both instances, for comparison:

| | gav-lib | testing |
| --- | ---: | ---: |
| protocol constants (code-owned, identical) | 35,644 | 35,644 |
| live state block | 21,508 | 31,292 |
| recent-conversation tail | 992 | 211 |
| system prompt total | 58,144 | 67,231 |
| tool definitions JSON | 23,017 | 23,017 |
| **prefix total (bytes)** | **81,161** | **90,248** |
| **prefix total (est. tokens)** | **20.8k–22.5k** | **23.1k–25.1k** |

Cross-check: `model.ts`'s own comment says "the whole ~22k-token prefix". My
independent byte count of 81,161 B for gav-lib lands at 21.9k tokens at 3.7 B/tok.
The two agree, which raises confidence in the 3.6–3.9 band.

### 2.2 What is actually inside those blocks

**Tool definitions, 23,017 B unlinked→linked jump.** 13 tools / 10,751 B when the
instance is unlinked; 22 tools / 23,017 B once `co link` has run. The dispatch and
feature tools more than double the tool prefix. Biggest individual definitions:

| tool | bytes |
| --- | ---: |
| `feature_enqueue` | 3,860 |
| `task_table` | 2,300 |
| `file_review` | 2,201 |
| `feature_create` | 1,769 |
| `doc` | 1,705 |
| `dispatch_order` | 1,388 |
| `search_web` | 1,380 |
| `feature_land` | 1,237 |
| `feature_resolve_head` | 1,202 |
| `feature_merge_head` | 943 |
| (12 others) | 3,032 |

`feature_enqueue` alone is 3,860 B — one tool description is 4.3% of the entire
fixed prefix, and its `prBody` parameter description restates the PR template that
the dispatch protocol section already carries in full.

**Live state, 31,292 B on `testing`.** Composition (`statically counted` file sizes):

| file | bytes | note |
| --- | ---: | --- |
| `docs/architecture.md` | 19,396 | privileged cold-start read |
| `.memory/activeContext.md` | 10,488 | rewritten every session exit |
| `.memory/projectbrief.md` | 864 | |
| task table snapshot | ~400 | read once at assembly |

`docs/architecture.md` alone is **21.5% of the entire fixed prefix** on that
instance. It is a captain-authored file with no size discipline anywhere in the code
path (`readSurfacedDocs` reads it whole), and it is re-read on every round of every
turn for the life of the session. On gav-lib the same file is 10,989 B.

**Bounded by design, and correctly so:** the recent-conversation tail is capped at
`TRANSCRIPT_TAIL_MAX_CHARS = 8,000` (`memory.ts`), and full logs are never loaded.
Both instances came in far under the cap (992 B and 211 B). The cold-start read path
is genuinely flat, exactly as the README claims.

### 2.3 What the prefix costs

The prefix is read at 0.1x, but it is read **on every round**, not every turn. With
P ≈ 24k tokens, 194 turns, and R rounds per turn:

| R | prefix reads | share of the 41.78M measured read tokens | share of total bill |
| ---: | ---: | ---: | ---: |
| 2 | 9.3M | 22.3% | 7.5% |
| 3 | 14.0M | 33.4% | 11.2% |
| 4 | 18.6M | 44.6% | 14.9% |

`estimated`. So the fixed prefix is plausibly **7–15% of the whole bill** despite the
0.1x rate — the "it's cheap once warm" intuition understates it, because "warm" still
means paying for it 400–800 times across a session.

---

## 3. Growth behaviour

**Nothing trims, compacts, summarises, or evicts anything from `state.messages`.**
Verified by reading every write to it: `runUserTurn` pushes the user turn,
`drainReviews` and `drainQueueNotices` push system turns, `syncActiveContext` pushes
the distill instruction, `runOpeningGreeting` pushes the greeting instruction, and
`drive()` ends with `state.messages = result.messages` where `runTurnInner` has
appended one assistant message per round plus one user message of tool results per
tool round. There is no `slice`, no drop, no compaction call, and no context-editing
parameter anywhere in the request builder. The array is append-only for the life of
the process.

Consequences, all `measured` or `estimated` as marked:

- **Read volume is the growth term.** Measured 215,335 cache-read tokens per turn
  (`measured`). Subtracting the prefix at R = 3 leaves ~48k tokens of history read
  per round — i.e. by mid-session the conversation is already twice the size of the
  entire system prompt and tool set combined.
- **Writes grow with it.** The rolling anchor writes the delta since the previous
  request, so per-session cache-write volume telescopes to roughly (prefix + final
  history size). Measured 2,555,006 write tokens over 24 sessions in the window =
  **106,459 written per session** (`measured` / `statically counted` session count).
  Subtracting one prefix write per session leaves ~82k of message-tier writes per
  session — 77.5% of all cache-write spend.
- **Short vs long session.** A 5-turn session at H ≈ 10k costs roughly 5 × 3 × 34k =
  510k read tokens ≈ $0.26, plus writes and output ≈ **$0.6 total**. The longest
  observed session in the transcripts (`2026-07-27T23-03-29-5344.md`, 70 transcript
  entries over 1,399 minutes) at the measured per-turn averages costs
  **≈ $11** — roughly 18x the short session for 14x the turns, the extra being the
  superlinear read growth. `estimated`.
- **Two things do bound growth, and neither touches context:** `autoArchiveLargeLogs`
  trims on-disk logs (explicitly off the read path), and the review inbox is capped
  at 20 records (`.dispatch/inbox.json`, not in context). Neither affects a turn's
  token cost.

The one structural mercy is that a session restart is cheap: cold start reads only
live state, the surfaced docs, and an 8,000-char tail, so the cost of a long session
does **not** carry into the next one. Quitting and reopening is, today, the only
history-trimming mechanism the app has — and it is a manual one the captain has to
know about.

---

## 4. Cache effectiveness

### 4.1 The breakpoints are landing — measured, not inferred

`model.ts` places four breakpoints: last tool definition, end of system, and two
rolling message anchors (`pickMessageBreakpoints`). The decisive evidence that they
work is the `input_tokens` column of the ledger: **690 uncached input tokens across
194 turns, 3.6 per turn**. Since Bedrock reports `inputTokens` as *only* the tokens
that were neither read from nor written to cache, a number that small means
essentially the entire prompt is being served from cache on every request. Read:write
ratio is 16.3:1.

This is the strongest single result in the audit and it required no live run — the
existing meter already proves it.

### 4.2 Structural placement, checked against AWS's documented behaviour

AWS documents the lookback that the lagging anchor exists for: *"the automatic prefix
checking only looks back approximately 20 content blocks from your cache checkpoint"*
([Prompt caching for faster model inference](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html),
accessed 2026-07-29). `LOOKBACK_BLOCK_BUDGET = 15` is correctly inside that window.

AWS also documents the ordering rule the app already satisfies: *"Cache checkpoints
are processed in this order: `tools` → `system` → `messages`"*, and *"changing content
in an earlier section invalidates the cache for later sections"* (same page). The app
builds `cachedTools` and `cachedSystem` once per turn and never rebuilds them
mid-turn, which is exactly right.

Deliberate anti-invalidation measures found in the code, all correct:
- `buildSystemPrompt` runs **once** at session start; mid-session memory writes never
  rebuild it (`session.ts`).
- The task table is a **snapshot** passed in as a value, with a comment saying why
  (`prompt.ts`: "a block that re-read the store per turn would change bytes
  underneath it and cost the whole cache"). The captain edits the same table live
  from the panel and it correctly does not leak into the prefix.
- `withMessageBreakpoints` copies rather than mutating, so markers cannot accumulate
  past the 4-per-request ceiling.

### 4.3 Where a miss is still likely

1. **A single round emitting more than ~20 content blocks.** `pickMessageBreakpoints`
   accumulates block counts until it crosses 15, then marks the message *before*
   that one. If the crossing message is itself large — say a round with 10
   `tool_use` blocks answered by 10 `tool_result` blocks — the lagging anchor can
   land 30+ blocks back, outside AWS's ~20-block window, and both message anchors
   then fail to find the previous entry. The budget bounds where the anchor *starts*
   looking, not how far one message can push it. `inferred` from the code; would show
   up as a `read 0` line under `CO_DEBUG_TIMING`.
2. **Mid-session `/effort`.** `model.ts` says outright that it assumes effort
   invalidates the message tier because Anthropic documents neither way. Anthropic's
   published invalidation hierarchy (accessed 2026-07-29) lists `tool_choice`,
   images, and thinking enable/disable as message-tier invalidators and does **not**
   list `output_config.effort` — so it remains genuinely unknown, and the code's
   pessimistic assumption is the right default.
3. **Cross-session sharing of the tools prefix.** Tools are static for the life of the
   binary, so the tools breakpoint (23,017 B ≈ 6.2k tokens) *can* be read cold by a
   later session — but only within the TTL. At 1h that is a real saving on
   back-to-back sessions; at 5m it would almost never hit.
4. **Sessions on different calendar days can never share a system prefix**, because
   `## Environment` carries `Today: <ISO date>`. Harmless within a session (the
   prompt is built once), but it caps cross-session reuse of the system tier at
   one day.

### 4.4 The TTL is defending the wrong thing

`CACHE_TTL = "1h"` is applied to **all four breakpoints**, including the two rolling
message anchors that are rewritten every single turn. AWS documents that a cache
entry's *"TTL resets with each successful cache hit"* and advises: *"If you have
prompts that are used at a regular cadence (i.e., system prompts that are used more
frequently than every 5 minutes), continue to use the 5-minute cache, since this will
continue to be refreshed at no additional charge"* (AWS prompt-caching page, accessed
2026-07-29).

So: how often does this captain actually pause longer than five minutes? That is
answerable from the transcripts, which stamp every turn.

Parsed 103 session transcripts (2,047 stamped entries, 1,944 inter-entry gaps);
and separately the 24 sessions inside the ledger window (800 gaps):

| | all 103 sessions | ledger window only |
| --- | ---: | ---: |
| gaps measured | 1,944 | 800 |
| median | 60s | 60s |
| p90 | 180s | 240s |
| p95 | 480s | 600s |
| **gaps > 5 min** | **126 (6.5%)** | **61 (7.6%)** |
| **gaps > 1 hour** | **34 (1.7%)** | **9 (1.1%)** |

`measured`, with one caveat that matters: transcript stamps are **minute-resolution**
(`## you · 2026-07-29 18:37 UTC`), so sub-minute gaps quantise to 0 or 60s and the
median is a floor, not a precise value. The 5-minute and 1-hour buckets are unaffected
by the quantisation and are the numbers that matter here.

Reading that: **92.4% of turn boundaries in the ledger window fall inside the
5-minute window**, where the cheaper cache would have been refreshed for free, and
**1.1% exceed an hour**, where the 1-hour TTL does not save them either. The 2x write
premium is being paid on 100% of write tokens to protect roughly 6.5% of turns.

That is a real finding, but the arithmetic on fixing it is closer than it looks —
see recommendation R2, where the net comes out at 0–8% and depends on a quantity I
cannot measure statically.

---

## 5. Model options

### 5.1 Pricing, read 2026-07-29

**The repo's pricing premise is wrong.** `src/cost.ts` states that "the same Opus 4.8
that costs $5/$25 per million on the Anthropic API costs $6/$30 here", and derives
every Bedrock rate as 1.2x first-party. The AWS Marketplace listing for **Claude Opus
4.8 (Amazon Bedrock Edition)** publishes these dimensions verbatim
([prodview-mv6skd5ti2kow](https://aws.amazon.com/marketplace/pp/prodview-mv6skd5ti2kow),
accessed 2026-07-29):

| dimension | price |
| --- | --- |
| "Input Tokens - Standard, Global" | $5.00 |
| "Output Tokens - Standard, Global" | $25.00 |
| "Cache Read Tokens - Standard, Global" | $0.50 |
| "Cache Write Tokens - Standard, Global" | $6.25 |
| "Cache Write Tokens (1h TTL) - Standard, Global" | $10.00 |

Identical to Anthropic's first-party list, not 1.2x. Anthropic's own pricing page
([platform.claude.com/docs/en/about-claude/pricing](https://platform.claude.com/docs/en/about-claude/pricing),
accessed 2026-07-29) gives Opus 5 the same numbers: $5 base input, $6.25 5m write,
$10 1h write, $0.50 cache hit, $25 output — and states the multipliers explicitly:
5-minute write 1.25x, 1-hour write 2x, cache read 0.1x base input.

**Caveat, stated plainly:** AWS's own [Bedrock pricing page](https://aws.amazon.com/bedrock/pricing/)
renders its current-generation Anthropic rows client-side and I could not extract
them (two attempts, 2026-07-29 — only the legacy "Claude 3.5 Sonnet Public Extended
Access" rows came through). The Opus 5 and Sonnet 5 Bedrock model cards both defer to
that page for pricing. So the table below is Opus **4.8**'s published Bedrock
dimensions plus Anthropic's list for the rest; **the exact published Bedrock row for
Opus 5 was not obtained from AWS and should be confirmed in the AWS console before
anyone acts on a rate change.**

Per MTok, on the assumption Bedrock matches list (which it demonstrably does for
Opus 4.8):

| model | input | output | 5m write | 1h write | read |
| --- | ---: | ---: | ---: | ---: | ---: |
| **Claude Opus 5** (current) | $5.00 | $25.00 | $6.25 | $10.00 | $0.50 |
| Claude Opus 4.8 | $5.00 | $25.00 | $6.25 | $10.00 | $0.50 |
| Claude Sonnet 5 (to 2026-08-31) | $2.00 | $10.00 | $2.50 | $4.00 | $0.20 |
| Claude Sonnet 5 (from 2026-09-01) | $3.00 | $15.00 | $3.75 | $6.00 | $0.30 |
| Claude Sonnet 4.6 | $3.00 | $15.00 | $3.75 | $6.00 | $0.30 |
| Claude Haiku 4.5 | $1.00 | $5.00 | $1.25 | $2.00 | $0.10 |

### 5.2 Capability verdict against the four things this app requires

Requirements, from `model.ts`: streaming on the InvokeModel / Anthropic Messages
shape; tool use; prompt caching via `cache_control`; adaptive thinking with
`output_config.effort`.

| candidate | streaming (Invoke/Messages) | tool use | `cache_control` caching | adaptive thinking + `effort` | verdict |
| --- | --- | --- | --- | --- | --- |
| **Opus 5** (current) | ✅ Invoke, Converse, Messages; bedrock-runtime **and** bedrock-mantle | ✅ | ✅ min **512** tok, 4 checkpoints, TTL **5m + 1h** | ✅ adaptive on by default; all five effort rungs | **usable — in use** |
| **Opus 4.8** | ✅ same surface | ✅ | ✅ min 1,024 tok, TTL 5m + 1h | ✅ adaptive only; all five rungs | **usable**, no price advantage |
| **Sonnet 5** | ✅ Invoke, Converse, Messages; runtime + mantle | ✅ | ✅ min **4,096** tok, 4 checkpoints, TTL **5m + 1h** | ✅ adaptive **always on, cannot be disabled**; effort configurable | **usable** — ~60% cheaper at intro rates |
| **Sonnet 4.6** | ✅ | ✅ | ⚠️ min 1,024 tok, **TTL 5 minutes only** | ⚠️ adaptive yes; **rejects `effort: xhigh`** | **usable but degraded** — loses the 1h TTL the app relies on |
| **Haiku 4.5** | ✅ | ✅ | ✅ min 4,096 tok, TTL 5m + 1h | ❌ **`output_config.effort` errors**; no adaptive thinking (pre-4.6 `budget_tokens` model) | **unusable** as the app is written — every request would 400 |

Sources: [Opus 5 Bedrock model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5.html),
[Sonnet 5 Bedrock model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5.html),
[Bedrock prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html) —
all accessed 2026-07-29.

Two entries deserve their footnote:

- **Haiku 4.5 is not a cheap tier for this app, it is a broken one.** Every request
  `model.ts` builds carries `output_config.effort` and `thinking: {type: "adaptive"}`.
  Haiku 4.5 rejects `effort` outright. It would need a code change to omit both
  before it could serve even a greeting. Reporting it on price alone would be wrong.
- **Sonnet 4.6's cache TTL is 5 minutes only** on Bedrock — the AWS prompt-caching
  table lists `anthropic.claude-sonnet-4-6` with "Supported TTL: 5 minutes", while
  Opus 4.5, Sonnet 4.5 and Haiku 4.5 all list "5 minutes, 1 hour". Moving to Sonnet
  4.6 to save money would silently remove the lever this app spent effort building.

### 5.3 Is the 1-hour TTL documented for the model in use? Yes — quoted

This is the question the brief flagged as potentially the cheapest lever, so here it
is directly. The Claude Opus 5 Bedrock model card
([docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5.html](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5.html),
accessed 2026-07-29) publishes:

| Prompt caching supported | Min tokens per cache checkpoint | Max cache checkpoints per request | Supported TTL | Fields that accept prompt cache checkpoints |
| --- | --- | --- | --- | --- |
| Yes | 512 | 4 | **5 minutes, 1 hour** | system, messages, and tools |

And the AWS prompt-caching page gives the exact wire form the app already sends:
*"In the InvokeModel API for Claude models, add `"ttl": "1h"` to your `cache_control`
object. If no `ttl` value is provided, the default 5-minute caching behavior
applies."*

Three consequences:

1. **The brief's premise is stale on this point.** The app already sends `ttl: "1h"`
   (`model.ts`, `CACHE_TTL`), and the code comment explaining that it was "measured
   rather than assumed" because the legacy path "does not document" the field is now
   out of date — it is documented, for this model, on this endpoint.
2. **The cache minimum is 512 tokens on Opus 5**, not the 1,024 the brief states.
   1,024 is Opus 4.8's figure. This matters: it means smaller message-tier
   breakpoints that would previously have silently failed to cache now do cache.
3. **The `us.` geo prefix is not the only option any more.** The same model card
   publishes `global.anthropic.claude-opus-5` alongside `us.` / `eu.` / `au.`. See R3.

### 5.4 Has anything changed that makes the `us.` profile or the non-Mantle endpoint
worth revisiting?

**Yes, on both counts, though only one is a cost question.**

- **Mantle is no longer a 404 in the documentation.** The Opus 5 model card lists
  **both** `bedrock-runtime` and `bedrock-mantle` as supported endpoints, with
  `anthropic.claude-opus-5` (no geo prefix) as the Mantle model id — exactly the form
  `model.ts` records as having 404'd on 2026-07-20 and 2026-07-27. That 404 was an
  **entitlement** result for this account, not a model-availability one, and nothing
  I can read from here tells me whether the entitlement has changed. **This is not a
  cost lever either way**: Mantle and runtime are the same model at the same price.
  It is a feature-parity question, and the app's stated reason for staying on runtime
  (it works, Mantle 404s for this key) is still the right call until someone re-probes.
- **The geo-vs-global endpoint choice *is* a cost question, and it is new.**
  Anthropic's pricing page (accessed 2026-07-29) states: *"Bedrock offers two endpoint
  types: global endpoints (dynamic routing for maximum availability) and regional
  endpoints (guaranteed data routing through specific geographic regions) … Regional
  and multi-region endpoints include a 10% premium over global endpoints,"* scoped to
  *"Claude Sonnet 4.5, Haiku 4.5, Opus 4.5, and all future models."* Opus 5 is a
  future model. `us.anthropic.claude-opus-5` is a regional (geo) profile. See R3 —
  including why I could not fully confirm it.
- **Tokenizer, for completeness.** Anthropic notes that Claude 4.7 and later use a
  newer tokenizer producing *"approximately 30% more tokens for the same text"* than
  the 4.6-and-earlier tokenizer. This does not change any recommendation here — all
  measured token counts already come from this tokenizer — but it does mean any
  comparison against a Sonnet 4.6 baseline would need re-baselining, not a rate swap.

---

## 6. Ranked recommendations

Percentages are against the **$62.46** measured window unless stated. Every saving
figure is `estimated` and the estimate's sensitivity is named.

### R0 — Do nothing (baseline)

$62.46 / 194 turns / 1.9 days. **$0.322 per turn, ~$32 per active day**, ~$970 per
30-active-day month (`estimated` from a small sample). Everything below is measured
against this. Nothing in this audit found a correctness or safety problem; doing
nothing is a legitimate outcome.

### R1 — Correct the Bedrock rate table in `src/cost.ts` · *saving: $0 · cost: one constant · risk: none* · **cheap and reversible**

Not a saving — an accuracy fix, and the precondition for every decision below.
`WRITE_5M_MULTIPLE` / `WRITE_1H_MULTIPLE` / `READ_MULTIPLE` are all correct (1.25x /
2x / 0.1x, confirmed against Anthropic's published multipliers). The error is the
base pair: the table encodes $6/$30 for the Opus tier where AWS Marketplace publishes
$5/$25. `/cost` currently overstates by exactly 20%. The `claude-opus-5` entry is
already flagged `confirmed: false` and prints "[rate derived, not published by AWS]",
so the meter is honest about its uncertainty — it is just wrong about the direction.
Fixing it makes every `/cost` and `co cost` figure real.

### R2 — Split the cache TTL: 1h on tools + system, 5m on the two message anchors · *saving: 0–8%, central ~5% · cost: one constant becomes two · risk: low, quantified* · **cheap and reversible**

The mechanism (§4.4): message anchors are rewritten every turn and consumed on the
next round seconds later; only the tools and system tiers need to survive a thinking
pause. AWS explicitly permits mixing — *"You can use both 1-hour and 5-minute cache
controls in the same request, but … a 1-hour cache entry must appear before any
5-minute cache entries"* — and the app's `tools` → `system` → `messages` order already
satisfies that constraint exactly.

The arithmetic, and why I am not selling this harder than it deserves:

- Message-tier writes ≈ 77.5% of 2,555,006 = **1,979,000 tokens**
  (`estimated`: total writes minus one ~24k prefix write per session × 24 sessions).
- Saving on those writes: 1,979,000 × ($10.00 − $6.25)/MTok = **$7.42**.
- Penalty: every gap > 5 min expires the message tier, forcing a re-write at $6.25
  instead of a read at $0.50. Measured 7.6% of 194 turn boundaries ≈ **15 events**.
  Cost per event = H × $5.75/MTok, where H is the history size at that moment.

| H at expiry | penalty | net | as % of bill |
| ---: | ---: | ---: | ---: |
| 30k | $2.59 | **+$4.83** | 7.7% |
| 50k | $4.31 | **+$3.11** | 5.0% |
| 80k | $6.90 | **+$0.52** | 0.8% |

**H is the quantity I cannot measure statically**, and the net swings by an order of
magnitude across its plausible range. The honest recommendation is: make the change
behind an env var, run a week with `CO_DEBUG_TIMING=true`, and compare the
`cache+`/`read` columns. This is cheap enough to test and reversible in one line, but
it is not the slam dunk the 92.4%-under-5-minutes figure makes it look like.

### R3 — Try `global.anthropic.claude-opus-5` instead of `us.` · *saving: ~9.1% if the premium applies · cost: one env var, zero code · risk: data residency* · **cheap and reversible**

Anthropic documents a **10% premium on Bedrock regional/geo endpoints over global**
for Opus 4.5 and all later models (§5.4). If it applies to Opus 5, the app is paying
it on every token class today, and dropping it is worth 1 − 1/1.1 = **9.1%** ≈ $5.68
over the measured window, ~$88/month at the extrapolated rate. The change is
`BEDROCK_MODEL_ID=global.anthropic.claude-opus-5` in `~/co-managers/.env` — no code
at all, and the model card confirms the global profile exists and covers us-west-2.

**Two reasons to verify before believing this.** First, the AWS Marketplace listing I
could read publishes only "Standard, **Global**" dimensions with no regional
counterpart, so I could not confirm the premium from AWS's own numbers — only from
Anthropic's description of AWS's pricing. Second, `global` *"routes anywhere
worldwide"*, while `us.` *"keeps data within US and Canada regions"*. That is a
policy decision about where this project's architecture conversations are processed,
not a technical one, and it is the captain's to make. Cheapest possible verification:
one hour on each profile with `CO_DEBUG_TIMING` and a look at the AWS bill.

### R4 — Shrink the fixed prefix · *saving: ~3–7% · cost: prompt surgery · risk: behavioural* · structural-ish

The prefix is read on every round, so at R = 3 it is ~11% of the bill (§2.3) and
halving it is worth ~5.5%. The three fattest code-owned targets, in order:

1. **Tool definitions, 23,017 B.** `feature_enqueue` (3,860 B) restates the five-section
   PR template that the dispatch protocol already carries in full; `task_table`
   (2,300 B) and `file_review` (2,201 B) likewise re-explain rules stated in their
   protocol sections. The duplication buys nothing the model does not already have
   two paragraphs earlier in the same prefix.
2. **Dispatch protocol, 15,398 B** — 17% of the prefix, present only when linked.
3. **`docs/architecture.md`, 19,396 B on `testing`** — 21.5% of the prefix, and
   captain-owned. There is no size discipline on it anywhere in `readSurfacedDocs`.
   A note in the docs protocol telling the co to keep it compact would cost nothing
   and is the only lever the code has over a file the captain writes.

Risk is real and asymmetric: this prompt is the app's behaviour. Cutting the wrong
2 KB costs output quality on every turn thereafter to save $0.02 a turn. I would take
(1) — the duplication is genuinely redundant — and leave (2) and (3) alone unless
someone is prepared to A/B the result.

### R5 — Trim or compact message history · *saving: est. 15–30% · cost: substantial · risk: real* · **structural**

The largest headroom in the audit, and the only item that attacks the growth term
rather than the constant. History is ~48k tokens of every ~72k-token round read at
R = 3, and 77.5% of write spend. Two documented mechanisms exist on Bedrock, both
beta:

- **Context editing** (`clear_tool_uses_20250919`) drops stale tool results while
  keeping the conversation structure. This app is tool-heavy and its tool results are
  the most disposable thing in its history — a `fetch_url` body capped at 12,000
  chars is read on every subsequent round of the session forever, long after the co
  has synthesised it.
- **Compaction** (`compact_20260112`) summarises earlier context server-side.

Both are listed as available-in-beta on Bedrock, but **neither is confirmed on the
legacy `bedrock-runtime` InvokeModel path this app is pinned to**, and I could not
test that without a credential. That verification is the first step, not the
implementation.

Risk: the co-manager's whole value is continuity of reasoning across a long
architectural conversation. Clearing tool results is low-risk (it keeps what the co
*said* about them); compaction is higher-risk (it replaces what the co said). If only
one lands, make it context editing.

### R6 — Drop the review record from message history once `file_review` has been called · *saving: est. 2–5% · cost: moderate · risk: moderate* · **structural**

A review record is already persisted twice — in `.dispatch/inbox.json` and in the
crew's own transcript — before it is ever read into the conversation. Keeping it in
`state.messages` afterwards pays for a median 5.2k-token block (p90 8.1k, max 17.6k)
on every subsequent round of the session. Replacing the record with a one-line
pointer *after* the `file_review` call lands would recover most of that.

**Do not fix this by truncating the crew report.** `crewtranscript.ts` and
`reviewrecord.ts` both carry a long, well-argued comment explaining that silent
truncation of completion reports previously cost eleven consecutive dispatches their
diffstats and verification output. That decision is correct and should stand. The
saving is in the *lifetime* of the block, not its size.

### R7 — Per-turn-type effort · *saving: est. 2–3% · cost: small · risk: unknown-unknowns* · cheap and reversible

The cold-start greeting already runs at `low`, correctly. The distillation turn and
the review turns are the remaining candidates — both are summarisation of context the
model already holds, which is exactly the shape `low` is for.

**But there is a trap, and it points the wrong way.** `model.ts` assumes changing
effort mid-session invalidates the message-tier cache. If that assumption is right,
running the distill at a lower effort would force a re-write of the entire
end-of-session history (~80k tokens at $6.25–$10/MTok = $0.50–$0.80) to save perhaps
$0.03 of output. **That would cost roughly ten times what it saves.** The greeting is
safe because it is the first call and nothing is cached yet; nothing else obviously
is. Measure the invalidation behaviour before touching this.

### R8 — Move the whole app to Sonnet 5 · *saving: ~60% at intro rates · cost: one env var · risk: high* · cheap and reversible

Listed for completeness, not recommended. All four required capabilities are present
(§5.2), the 4,096-token cache minimum is comfortably cleared by a ~24k-token prefix,
and at $2/$10 through 2026-08-31 the measured window would have cost roughly $25
instead of $62. `config.ts` already clamps effort per model and both Sonnet ids are
recorded as working on this account.

The reason it is not a recommendation: this app exists to be the sharpest
architectural reasoner in the room, and the money it spends is the point. A 60% saving
on the thing you built specifically to be expensive is a product decision, not a cost
optimisation. If it is ever taken, take it as an explicit downgrade with eyes open,
not as tuning — and note the intro pricing expires 2026-08-31, after which the saving
drops to ~40%.

### Summary

| # | recommendation | est. saving | implementation | quality risk | class |
| --- | --- | ---: | --- | --- | --- |
| R0 | do nothing | — | — | none | baseline |
| R1 | fix the rate table | $0 (accuracy) | one constant | none | cheap, reversible |
| R2 | split cache TTL | 0–8% | one constant → two | low | cheap, reversible |
| R3 | `global.` inference profile | ~9.1% | one env var | none (policy, not quality) | cheap, reversible |
| R4 | shrink the fixed prefix | 3–7% | prompt surgery | medium | cheap, reversible |
| R5 | trim / compact history | 15–30% | substantial | high | structural |
| R6 | evict review records after filing | 2–5% | moderate | medium | structural |
| R7 | per-turn-type effort | 2–3% | small | unknown | cheap, reversible |
| R8 | move to Sonnet 5 | ~60% | one env var | high | cheap, reversible |

R1 + R2 + R3 together are three constants and one env var, and carry no output-quality
risk between them.

---

## 7. Verified vs inferred

### Established by measurement (existing instrumentation)

- Every token and turn figure in §1.1, from the two live `.cost.json` ledgers.
- The model actually in use is `us.anthropic.claude-opus-5`, set in
  `~/co-managers/.env` and recorded as the ledger key in both instances.
- Caching is engaging: 690 uncached input tokens across 194 turns.
- Crew final-report sizes: 92 samples, median 3,226 B, p90 13,926 B, max 49,111 B.
- Inter-turn gap distribution: 1,944 gaps across 103 transcripts; 6.5% exceed 5
  minutes, 1.7% exceed 1 hour (7.6% / 1.1% within the ledger window).

### Established by static counting

- Every byte figure in §2, produced by importing the real `buildSystemPrompt` and
  `toolDefinitions` and measuring the assembled output. No source file was modified.
- Fixed prefix: 81,161 B (gav-lib) and 90,248 B (testing), of which 35,644 B is
  code-owned protocol constants identical across instances.
- Tool definitions: 10,751 B unlinked (13 tools) → 23,017 B linked (22 tools).
- 24 sessions started inside the ledger window.
- `state.messages` has no trimming path — verified by reading every write to it.

### Established from published documentation (accessed 2026-07-29)

- Bedrock Opus-tier rates and the 1.25x / 2x / 0.1x cache multipliers.
- Opus 5 on Bedrock: cache minimum 512 tokens, 4 checkpoints, TTL 5m **and** 1h,
  checkpoints allowed in system/messages/tools, available on both `bedrock-runtime`
  and `bedrock-mantle`, `global.` profile published alongside `us.`/`eu.`/`au.`.
- The ~20-content-block cache lookback window (which validates
  `LOOKBACK_BLOCK_BUDGET = 15`).
- Sonnet 4.6's Bedrock cache TTL is 5 minutes only; Haiku 4.5 rejects
  `output_config.effort`.

### Inferred from the code, not measured

- Round-count-dependent figures (§1.2, §2.3): rounds per turn are recorded nowhere,
  so anything expressed per-round is a band, not a number.
- The >20-block lagging-anchor edge case (§4.3 item 1) is a code reading; it has not
  been observed.
- The message-tier share of cache writes (77.5%) is derived from total writes minus
  an estimated one prefix write per session.
- Bytes-per-token is estimated at 3.6–3.9 throughout. No tokenizer was used (zero new
  dependencies), and `count_tokens` needs a credential.

### Could not be determined without a live, credentialled run

State plainly, these are the figures this audit does **not** have:

1. **Rounds per turn.** The single largest source of uncertainty. It gates the
   per-turn-type budget, the prefix's share of the bill, and R4's value. One session
   with `CO_DEBUG_TIMING=true` would resolve it — the `⏱ turn: … over N round(s)`
   line already prints it and nothing records it.
2. **Average history size at a >5-minute pause (H).** Swings R2's net saving from
   0.8% to 7.7%.
3. **Whether `output_config.effort` invalidates the message-tier cache.** Anthropic
   documents neither way. Gates R7 entirely, and R7 is net-negative if the
   pessimistic assumption holds.
4. **Whether the 10% regional premium actually applies to `us.anthropic.claude-opus-5`
   on this account.** Documented by Anthropic, not visible on the AWS Marketplace
   dimensions I could read. Gates R3's entire ~9.1%.
5. **AWS's own published Bedrock row for Opus 5.** The pricing page renders
   client-side; I used Opus 4.8's Marketplace dimensions plus Anthropic's list as the
   best available substitute.
6. **Whether context editing and compaction work on the legacy `bedrock-runtime`
   InvokeModel path.** Documented as beta on Bedrock; the legacy path's parity is
   explicitly not promised. Gates R5.
7. **Whether Mantle is still 404 for this account.** Not a cost question either way,
   but it is the standing assumption in `model.ts` and it is now a year stale in
   documentation terms.
8. **Exact token counts for anything.** Every token figure here is bytes ÷ 3.6–3.9.

### Corrections to the brief's stated facts

Recorded because the brief asked for confirmation or refutation, not acceptance:

| brief states | actual |
| --- | --- |
| model id `us.anthropic.claude-opus-4-8` | `us.anthropic.claude-opus-5` (env var overrides the `DEFAULT_MODEL_ID` constant, which is still 4.8) |
| cache TTL is the 5-minute default; 1h "deliberately NOT used" | `CACHE_TTL = "1h"`, shipped, and documented as supported for Opus 5 on Bedrock |
| 1h TTL "unconfirmed for Opus 4.8" | confirmed for Opus **5** on the Bedrock model card; confirmed in the Marketplace dimensions for Opus **4.8** |
| model's cache minimum is 1,024 tokens | 512 for Opus 5 (1,024 is Opus 4.8's figure) |
| measured: 8,394 cache tokens on a cold turn | the prefix is now 22–25k tokens; that measurement predates the dispatch protocol and feature tools |

Also noted in passing, not a cost item: `CO_MAX_TOKENS` defaults to **32000** in
`config.ts`, while both `README.md` and `.env.example` document 8192. `max_tokens` is
a ceiling and is not billed, so this costs nothing — but the docs are wrong.

---

## Diffstat

```
 cost-audit-2026-07.md | 870 ++++++++++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 870 insertions(+)
```

One new file. No existing source file was modified, per the order. `src/cost.ts` and
the cost commands were read only.

## Verification actually run

Baseline, before the file was added:

```
$ npm run typecheck
> comanager@1.0.0 typecheck
> tsc --noEmit

=== TYPECHECK EXIT: 0 ===
```

```
$ npm test
1..782
# tests 782
# suites 0
# pass 781
# fail 0
# cancelled 0
# skipped 1
# todo 0
# duration_ms 29055.520417
```

After adding the file, both re-run — output identical: typecheck exit 0, 782 tests,
781 pass, 0 fail, 1 skipped. That is the expected result: the only change is one new
markdown file at the repo root, which neither `tsc --noEmit` nor
`tsx --test src/*.test.ts src/*/*.test.ts` reads.

Nothing was failing before this work started. The 1 skipped test is pre-existing and
skipped in the baseline run above, before any change.

No live model call was made and no Bedrock credential was used, sought, or present.

## Approaches tried and abandoned

- **Counting tokens with a real tokenizer.** Rejected: the order forbids new
  dependencies, and `messages.count_tokens` needs a credential. Fell back to exact
  byte counts plus a stated 3.6–3.9 B/token band, and cross-checked the band against
  `model.ts`'s own independent "~22k-token prefix" estimate, which it matches.
- **Reading current Anthropic rows off `aws.amazon.com/bedrock/pricing`.** Tried
  twice; the page renders its model tables client-side and only the legacy
  "Public Extended Access" rows came through. Substituted the AWS Marketplace
  Bedrock-Edition listing, which publishes dimension prices server-side, and said so.
- **Finding an AWS Marketplace listing for Opus 5 specifically.** Searched; only
  4.5/4.6/4.7/4.8 listings surfaced — the model launched 2026-07-24, five days before
  this audit. Used Opus 4.8's published dimensions (identical tier, same list price)
  and flagged the substitution rather than presenting it as an Opus 5 quote.
- **Deriving rounds-per-turn from the ledger.** Tried: `cacheRead / turn` gives only
  the product of rounds and context size, and neither factor is separable without the
  other. Abandoned in favour of presenting the round count as a band and listing it
  first among the things a live run would settle.
- **Measuring inter-turn gaps to sub-minute precision.** The transcript stamps are
  minute-resolution (`## you · 2026-07-29 18:37 UTC`), so the median is a floor. Kept
  the analysis because the 5-minute and 1-hour buckets — the only ones the TTL
  decision turns on — are unaffected by the quantisation, and said so explicitly
  rather than quietly reporting a precise-looking median.
- **Recommending a cap on crew completion reports** (the brief's hypothesis 5).
  Dropped after reading the comments in `crewtranscript.ts` and `reviewrecord.ts`:
  silent truncation of those reports has already cost this project eleven dispatches'
  worth of diffstats and verification output, and the decision to leave them
  unbounded is sound. Redirected the recommendation to the block's *lifetime* in
  message history (R6) instead of its size.
- **Recommending a lower effort for the end-of-session distill.** Worked the
  arithmetic and abandoned it: if effort invalidates the message-tier cache — which
  `model.ts` assumes and Anthropic does not document either way — the forced re-write
  costs about ten times the output saving. Kept it in R7 as a measure-first item with
  the trap named.

--- END OF REPORT ---
