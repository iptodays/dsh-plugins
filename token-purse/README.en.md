# TokenPurse

**Turns the tokens a DSH session burns into money you can actually see.**

TokenPurse is a DSH Web client plugin. It adds a small badge to the session stats
row under the composer (the line with turns · steps · tok/s and tokens · cache hit)
showing roughly how much the session has cost so far, and opens
a panel with the four billing buckets (uncached input / cache read / cache write /
output), their token counts and subtotals, plus an inline rate editor.

- Package: @dsh-plugins/token-purse
- Chinese name: 鲸囊 (a whale's purse)
- Shape: browser-only plugin (empty host half)

## What it looks like

- Idle: a compact **≈$0.0123** badge; the **≈** marks it as an estimate.
- Click: a dropdown listing each bucket, the priced model, the total token count
  and a short disclaimer.
- Bottom of the panel: **Edit rates** — expands into both the JSON rate override and
  the currency / FX settings, stored in the browser's localStorage.
- Nothing renders until the session has billed at least one token, so an empty
  session stays clean.

### Panel layout

The same total can be broken down three ways (**Models / Peak / Daily**). Showing all
three at once made the popover very tall, so they are **segmented tabs — only one is
rendered at a time**. From top to bottom:

1. the **total**, current model, and rate source;
2. the **scope**: Session / All time;
3. **token buckets** (input / cache read / output + total);
4. the **current bracket** (peak / off-peak, with window and multiplier);
5. the **segmented tabs** and the active tab's content;
6. the disclaimer, then **Edit rates**.

### Scope: Session / All time

- **Session** (default) reads the current session's incremental ledger — the same
  figure as the badge under the composer.
- **All time** folds together the **daily store** (90 days, across every session) and
  reports the total, the four token buckets, the per-model and per-bracket sums, and
  labels the model line with how many **days / sessions / models** it covers.

All time needs **no new storage**: the daily store already is a global ledger, keyed by
day × session × model × bracket with all four buckets. The accumulated amounts are
recomputed from that same data, so the two scopes cannot disagree — within the All time
scope the parts always add up to the total at the top.

The **Daily** tab has always spanned sessions, so the scope does not affect it.

Currency and FX are settings, so they live inside **Edit rates**; a day's per-model
detail needs a click on that day. A typical panel is about 260–310px tall.

### Motion

The panel does not just pop in. Every transition is short and never blocks input:

- **Panel**: fades in with a small lift on open (180ms); on close it plays a 130ms
  exit before unmounting, and clicking the badge mid-exit **cancels the close**.
- **Tab content**: switching Models / Peak / Daily remounts and fades the body in (180ms).
- **Share bars**: grow from 0 to their width (420ms, ease-out).
- **Sparkline**: normalised with `pathLength="1"` and drawn via `stroke-dashoffset`
  (900ms), then the area fades in. Width changes never distort the stroke
  (`non-scaling-stroke`).
- **Expanding a day**: its detail fades in (160ms).
- **Badge / chevron / buttons**: background and colour transitions (120–160ms); the
  chevron rotates 180°.
- **Sparkline callout**: fades in on appear (120ms).

All of it is plain CSS keyframes and transitions — **no animation library** — and it
honours `prefers-reduced-motion: reduce`, which switches every animation off.

## How it works

1. The host @deepseek-ai/dsh-token-meter plugin maintains a **tokenUsage** session
   projection that accumulates the four disjoint provider-reported buckets:
   **uncachedInputTokens**, **cacheReadTokens**, **cacheWriteTokens**,
   **outputTokens**.
2. The browser reads it through the standard **useProjection("tokenUsage")** prop.
3. It reads **useProjection("modelSelection")** for the current (or last used)
   **provider / model** and resolves a rate: provider/model exact, then model exact,
   then model substring, then fallback. When nothing matches it shows **Unpriced** and
   estimates with the generic fallback.
4. cost = Σ(bucket tokens × USD per million tokens) × currency factor, with each
   bucket priced at its off-peak or peak rate.
5. It is all local: config and the incremental ledger live in localStorage. The only
   network call is one request to a public FX endpoint when you click **Auto-fetch
   rate** (or turn auto on) — no session data is ever sent.

Implementation note: the stats row is rendered directly by
@deepseek-ai/dsh-client-ui-chat and is not a slot, so the plugin portals its badge
into the element carrying data-composer-stats and shares that flex row with the
existing pills. No stats row (empty session) means no badge.

## Install

Assumes a running **dsh web** (or desktop) with its profile at
**$DSH_HOME/profiles/web**.

### Option 1 — install straight from GitHub (recommended)

    dsh plugin --profile web add "github:iptodays/dsh-plugins#path:token-purse"

- `github:` makes pnpm fetch the repository; `#path:token-purse` selects the
  subdirectory inside the monorepo — the repository root is not a package, so
  `path:` is required.
- **Keep the quotes**: `#` starts a shell comment, so an unquoted spec is truncated.
- To **pin a version**, put the committish after `#` and join `path:` with `&`:

      dsh plugin --profile web add "github:iptodays/dsh-plugins#<full-sha>&path:token-purse"

  A branch or tag name works too. It must be a **full 40-character SHA** — a short
  SHA is treated as a ref name and fails to resolve.
- To upgrade, re-run the same command; pnpm caches git dependencies, so use
  `dsh plugin --profile web update` to force re-resolution if needed.

### Option 2 — install from a local checkout (when developing this plugin)

    dsh plugin --profile web add file:/path/to/dsh-plugins/token-purse

Both forms just forward to pnpm inside the profile directory, so this is equivalent:

    cd "$DSH_HOME/profiles/web"
    pnpm add "github:iptodays/dsh-plugins#path:token-purse"

### Mount it

Insert this into the top-level array of
**$DSH_HOME/profiles/web/cordis.patch.yml**:

    - insert:
        - id: ui-token-purse
          name: "@dsh-plugins/token-purse"

Save. patchReload is live, so it picks the change up; refresh the page and send
a message — the **≈¥...** badge appears in the stats row under the composer.

A ready-made snippet ships as **cordis.patch.yml**.

## Rates

Built-in rates come from two **traceable** sources and are quoted in **CNY per
million tokens**; each entry carries its own **currency** (CNY by default):

    # DeepSeek official
    deepseek-official/deepseek-flash            input 1.00   cacheRead 0.020   cacheWrite 1.00   output 4.00    peakMultiplier 2
    deepseek-official/deepseek-v4-flash         input 1.00   cacheRead 0.020   cacheWrite 1.00   output 4.00    peakMultiplier 2
    deepseek-official/deepseek-v4-pro           input 4.50   cacheRead 0.150   cacheWrite 4.50   output 13.50   peakMultiplier 2

    # packyapi (official CNY x group multiplier)
    packyapi/deepseek-flash             x0.8    input 0.80   cacheRead 0.016   cacheWrite 0.80   output 3.20    peakMultiplier 2
    packyapi/deepseek-v4-flash-vision-exp x0.8  input 0.80   cacheRead 0.016   cacheWrite 0.80   output 3.20    peakMultiplier 2
    packyapi/deepseek-v4-flash          x0.5    input 0.50   cacheRead 0.010   cacheWrite 0.50   output 2.00    peakMultiplier 2
    packyapi/deepseek-v4-pro            x0.5    input 2.25   cacheRead 0.075   cacheWrite 2.25   output 6.75    peakMultiplier 2

- **deepseek-official** is DeepSeek's list price (api-docs.deepseek.com/zh-cn/quick_start/pricing).
- **packyapi** discounts the official CNY list: x0.8 in the deepseek-officially group and
  x0.5 in the deepseek-sale group. Its page renders a `$` glyph, but the numbers are the
  official yuan price x multiplier (e.g. v4-pro list ¥4.5 -> $2.25), i.e. billed in CNY.
- Peak = 2x off-peak, weekdays 09:00-12:00 and 14:00-18:00 Beijing time.
- The official docs now serve deepseek-v4-flash / -vision-exp from V4.1-Flash and bill
  them at Flash prices; deepseek-v4-pro is scheduled to route there after 2026-09-14 12:00.
- Models not in the table (e.g. other packyapi groups) show **Unpriced** rather than a guess.

**The same model id can cost different amounts at different providers** —
deepseek-flash is two different prices at packyapi and deepseek-official. So rate
keys accept **provider/model**: a provider-prefixed entry applies only to that
provider, while a bare model id is a generic fallback.

Next to the priced model, the panel labels where the rate came from: **Provider
rate** (exact provider/model), **Generic rate** (bare model id), **Model match**
(substring), or **Unpriced** (fallback). When nothing matches it also spells out
**no rate configured for this model** and estimates with the generic fallback
instead of pretending to be exact.

Override either way:

1. **Recommended**: open the badge → **Edit rates**, edit the JSON, save. Stored
   under the **dsh.token-purse.config.v2** localStorage key (v1 migrates on read).
2. Edit **DEFAULT_MODELS** / **FALLBACK_RATES** at the top of **src/client.js**,
   then run **npm run build**.

Config shape:

    {
      "currency": { "code": "CNY", "symbol": "¥", "perUsd": 7.2, "auto": true },
      "fx": { "USD": 1, "CNY": 7.2 },
      "peak": {
        "timezone": "Asia/Shanghai",
        "windows": ["Mon-Fri 09:00-12:00", "Mon-Fri 14:00-18:00"]
      },
      "models": {
        "packyapi/deepseek-flash": { "currency": "CNY", "input": 0.80, "cacheRead": 0.016, "cacheWrite": 0.80, "output": 3.20, "peakMultiplier": 2 },
        "deepseek-official/deepseek-flash": { "currency": "CNY", "input": 1, "cacheRead": 0.02, "cacheWrite": 1, "output": 4, "peakMultiplier": 2 },
        "my-usd-model": { "currency": "USD", "input": 0.1, "output": 0.2 }
      }
    }

- **currency.symbol**: display symbol, up to 4 characters.
- **currency.perUsd**: units per 1 USD (use the FX rate for CNY).
- **currency.code / currency.auto**: currency code and the auto-refresh flag (the
  panel maintains them when you pick a currency).
- **fx**: units per 1 USD for each currency, used to convert a rate entry's own
  currency into the display one. The display currency itself follows
  **currency.perUsd**. Ignore it if every entry is in CNY.
- **peak.timezone**: IANA zone, e.g. **Asia/Shanghai**. **peak.windows** is a list of
  weekday-and-time ranges, accepting **Mon-Fri**, **Sat,Sun** and **\***. Entries
  that fail to parse are dropped; if none parse, there is no peak pricing.
- **models**: keys may be **provider/model** (recommended) or a bare lowercase
  model id. Matching is provider/model exact, then model exact, then longest model
  substring, then fallback; provider-prefixed keys never take part in substring
  matching. So **deepseek-v4-flash-exp** hits **deepseek-v4-flash** when nothing
  more specific matches.
- **models[].currency**: the currency that entry is quoted in (CNY by default). When
  providers differ, the plugin converts through **fx** to USD and then applies
  **currency.perUsd** for display.
- Missing **cacheRead** / **cacheWrite** fall back to **input**. A missing
  **peakMultiplier** (or one ≤ 1) means that model has no peak pricing.

### Time-of-day pricing (peak)

DeepSeek official (and packyapi, which resells it) charges double during weekdays
**09:00-12:00** and **14:00-18:00** (Asia/Shanghai). Enable it by giving a model a
**peakMultiplier** and putting the ranges in the top-level **peak.windows**.

- Ranges are evaluated in **peak.timezone**, independent of your system zone, and
  are **half-open** (12:00 sharp already counts as off-peak); they only apply on the
  listed weekdays.
- The **badge itself shows the current mode**: peak-priced models get a small pill next to the
  amount reading **Off** or **Peak×2** (hover for the windows), and the panel repeats it under
  **Current pricing**.
- Cost is split by **when each usage increment happened**: the plugin appends every
  increase of the session totals with a timestamp to
  **dsh.token-purse.ledger.v1:<sessionId>** and prices each entry with its own
  bracket, so a cross-bracket session is summed per segment, not priced by the
  current clock.
- One approximation remains: history from before the plugin was installed, or from
  while the page was closed, has no timestamp and is priced at the bracket in effect
  when the panel first opened. A refresh does not clear the ledger (it is persisted
  per session id).

## Peak / off-peak spend

The **Peak / off-peak** section groups the **current session** by the rate bracket that was in
effect when each increment was observed:

- **Peak**: inside a configured time window and the model has `peakMultiplier > 1`.
- **Off-peak**: same model, outside the window.
- **Flat**: the model has no time-of-day pricing (`peakMultiplier` is 1).

Each row shows tokens, amount, and a share bar. The section appears as soon as a session has any
peak or off-peak spend; if everything is flat-priced it is omitted as noise. The three amounts
always sum to the total at the top of the panel.

Matching that, any **day with peak (or flat) usage** in **Daily** gets an extra line under the
date — `Peak ¥x · Off-peak ¥y` — so you can see whether moving work off-peak actually paid off
over weeks.

## Daily stats

The bottom of the panel lists the last few days' tokens and spend (up to 7):

    01-07  2.5M  ¥8.00
    01-06  1M    ¥1.00
    01-05  4M    ¥13.50

- **Aggregated across sessions**: every session that has opened the panel on this machine
  contributes; it lives under **dsh.token-purse.daily.v1** and is kept for **90 days**.
- Each day is re-priced with the **current rates**, so later rate or currency edits also
  change past days.
- A day is the local date of the **observation time**; as above, history from before the
  plugin was enabled lands on the day it was first observed. Deleting that key resets it.
- Under the heading sits a **last-30-days spend sparkline** (plain SVG, no axes). Days with no
  usage count as **0**, so the shape shows real gaps instead of a misleading straight line
  between distant points; the peak and daily average are labelled next to it. It plots spend only.
- **The line is readable**: hovering shows that day's **date and amount** (with a guide line and
  a marker dot), and focusing the chart then pressing **← / →** steps through the days. Near the
  edges the callout pulls itself in so it never overflows the panel. With a fresh install there
  are few points, so the line looks flat — that is expected until a few weeks of data accumulate.

## By provider and model

When more than one provider or model is in play, the panel adds a **By model** block listing
each **provider / model** used in this session with its tokens and spend, largest first, plus
a share bar:

    deepseek-official / deepseek-flash   2.1M   ¥2.62
    packyapi / deepseek-v4-pro           400K   ¥0.90

- It only appears with **two or more** provider/model pairs; with a single model the header
  already says it, so no space is wasted.
- Rates match on **provider/model** first, then fall back to the bare model name and finally to
  the generic rate; the source chip at the top of the panel says which one applied.
- In **Daily**, a day that used several models indents them under that day; single-model days
  stay collapsed.
- Everything is **priced per segment and then grouped**, so the per-model amounts add up to the
  badge total.

## Currency

Open the badge → **Edit rates**; the lower half of the editor has **Currency** and **Rate** rows:

- Pick a common currency (USD / CNY / EUR / GBP / JPY / HKD / TWD / KRW / SGD /
  INR) from the dropdown — it carries an example rate;
- Edit **1 USD =** with your real rate; Enter or blur saves it.

### Auto-fetch

- Click **Auto-fetch rate**: it pulls the live rate for the current currency and
  writes it back (open.er-api.com first, currency-api.pages.dev as fallback).
- Tick **Auto** and the rate refreshes when you open the panel if the last fetch is
  older than 12 hours.
- On failure (offline / blocked / unsupported currency) it says so and **keeps your
  current rate** — it never overwrites it.
- Only the rate is requested; no session data is sent, and the request goes out
  directly from your browser.

Changes persist to localStorage under **dsh.token-purse.config.v2** and the badge
recomputes immediately. The rate means units of that currency per 1 USD. For an
arbitrary symbol or rate, use **Edit rates** and set **currency.symbol** /
**currency.perUsd**.

## FAQ

- **No badge?** It renders only once the session has billed tokens (> 0). If it
  stays hidden after a message, check the browser console for slot errors and make
  sure @deepseek-ai/dsh-token-meter is enabled.
- **Amount is 0 or too small?** The model probably missed the rate table, or the
  provider reported no usage (the projection is then empty).
- **What does ≈ mean?** Estimate. DSH does not bill; this just multiplies tokens
  by local rates.
- **Numbers disagree with my bill?** The official and packyapi figures both come from
  public price lists, but your group, gateway markup, and whether cache write is
  billed can all differ — use **Edit rates** to calibrate against your own bill.
- **How are sessions that cross peak/off-peak priced?** See **Time-of-day pricing**
  above: observed usage is split by the moment it happened; history from before the
  plugin was installed is priced at the bracket in effect when the panel opened.

## Layout

    token-purse/
      package.json          package + dsh.client manifest
      lib/index.js          host half (empty; gives the Loader a row)
      lib/client.js         build artifact: browser half
      src/client.js         browser half source (edit this)
      scripts/build.mjs     dependency-free bundler
      scripts/smoke.mjs     dependency-free smoke test
      cordis.patch.yml      install snippet
      README.md             中文
      README.en.md          this file

## Develop

    npm run build
    npm run check
    npm test

The browser half is served by DSH exactly as written, so editing
**lib/client.js** under a running **pnpm run dev:web** triggers client HMR;
otherwise refresh the page.

## Changelog

- **0.1.12**: the sparkline is **readable** — hovering shows the day's date and amount with a
  guide line and marker; focusing it and using ← / → steps through days. The callout pulls in
  near the edges and fades in.
- **0.1.11**: a **scope switch** (**Session / All time**). All time folds the daily store
  (90 days, every session) into the total, the token buckets, and the per-model and
  per-bracket breakdowns, labelled with the days / sessions / models it covers. No new
  storage is involved and the parts always sum to the total.
- **0.1.10**: **Motion.** Panel fade-in/exit (cancellable mid-exit), tab-body fade,
  growing share bars, a drawn sparkline, a fading day detail, button and chevron
  transitions — all plain CSS and `prefers-reduced-motion` aware. Docs gained the
  **install straight from GitHub** route (`github:iptodays/dsh-plugins#path:token-purse`)
  and how to pin a SHA.
- **0.1.9**: **Slimmed the panel.** The three breakdowns (Models / Peak / Daily) became
  segmented tabs with only one rendered at a time; a day's per-model detail now expands
  on click; currency and FX moved inside **Edit rates**. Nodes went 197 → 49–81 and the
  height about 1000px → 240–290px.
- **0.1.8**: a **Peak / off-peak** section (three groups with share bars) and a peak/off-peak
  line for days that had peak usage. The bracket flag is now three-state with a legacy
  fallback.
- **0.1.7**: a **last-30-days spend sparkline** above **Daily** (missing days zero-filled, peak
  and average labelled).
- **0.1.6**: the rates editor no longer says "USD", and a **legacy USD config from 0.1.0 is
  upgraded to CNY** once.
- **0.1.5**: a **By model** breakdown (per provider/model spend for this session, with share
  bars), per-model rows inside **Daily**, and a sectioned panel layout.
- **0.1.4**: **daily stats** in the panel (aggregated across sessions, 90 days kept); the
  **Split** switch from the previous release is gone.
- **0.1.3**: optional peak/off-peak amount split, toggled by **Split** in the panel and stored
  as **ui.peakSplit**.
- **0.1.2**: the badge shows the current peak/off-peak mode (**Off** / **Peak×2**) and the
  panel labels it **Current pricing**.
- **0.1.1**: built-in rates switched to DeepSeek's official CNY list price and packyapi's
  full model set (x0.8 / x0.5 groups); per-entry **currency** plus a top-level **fx** table;
  the default display currency is now CNY.
- **0.1.0**: badge + uncached/cache-read/cache-write/output breakdown; currency switch
  and auto FX; packyapi time-of-day pricing for deepseek-flash (**peakMultiplier** /
  **peak.windows**) billed per usage increment; provider/model-scoped rates with a
  source label in the panel.

## License

MIT