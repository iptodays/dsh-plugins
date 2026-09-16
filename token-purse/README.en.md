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
- Click: a dropdown listing each bucket, the priced model and the total token count.
- Bottom of the panel: **Edit rates** — the currency / FX rows plus a **JSON** block that
  overrides the rates; **configuration problems** (path + reason) are listed beneath the JSON, so
  invalid values fall back to something workable but never silently. Stored in localStorage.
- Nothing renders until the session has billed at least one token, so an empty
  session stays clean.

### Panel layout

The same total can be broken down three ways (**Models / Peak / Daily**). Showing all
three at once made the popover very tall, so they are **segmented tabs — only one is
rendered at a time**. From top to bottom:

1. the **total** (hover it for the scope caveat and the disclaimer), the current model and
   the rate source;
2. the **scope**: Session / All time;
3. **token buckets** (input / cache read / output + total);
4. the **view tabs** — Models / Peak / Daily, plus **Projects** in the All time scope —
   only the active one is rendered; the current bracket (peak / off-peak under a surcharge scheme,
discount / standard under a discount one, plus the window and
   multiplier) lives in the **Peak** tab;
5. **Edit rates**.

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

**Which sessions does All time cover?** Only sessions **this plugin has recorded**. The host
does not expose other sessions' usage (a session-list row's projections are only
`modelSelection / imageLimits / sessionListMetadata` — there is no `tokenUsage`), so the
plugin cannot see history it never observed: sessions from before installation, or ones it
never opened, are not included. That is a limit, not a defect. On the other hand, **opening a
session once** is enough — its ledger is recorded into the daily store immediately (usage it
had already accumulated lands on the day it was first observed). The model line in All time
reports the days, sessions and models actually covered.

When several pages are open (multiple tabs, or a stale tab you forgot to close), the merge
**re-reads localStorage** before writing back, so an old page cannot wipe records for sessions
it never saw.

**All time splits by project and session.** Its first tab is **Projects**: one row per project
(directory name; hover for the full path, tokens, amount and a share bar). Click one to list
**every session** under it and what each spent, using the session's title where available. A
single project expands automatically. The project comes from the session's **working
directory** and is written into the daily store with each record, so **older rows** (recorded
before 0.1.14) start under "Unknown project" and get corrected the next time you open that
session.

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
   bucket priced at its base rate, then scaled by the scheme in effect at that moment — the
multiplier applies inside the window and the base price outside it.
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

    # DeepSeek official                          input   cacheRead   cacheWrite   output
    deepseek-official/deepseek-flash              1.00    0.020       1.00         4.00
    deepseek-official/deepseek-v4-flash           1.00    0.020       1.00         4.00
    deepseek-official/deepseek-v4-pro             4.50    0.150       4.50        13.50

    # packyapi (official CNY x group multiplier)  group
    packyapi/deepseek-flash                 x0.8   0.80    0.016       0.80         3.20
    packyapi/deepseek-v4-flash-vision-exp   x0.8   0.80    0.016       0.80         3.20
    packyapi/deepseek-v4-flash              x0.5   0.50    0.010       0.50         2.00
    packyapi/deepseek-v4-pro                x0.5   2.25    0.075       2.25         6.75

- **deepseek-official** is DeepSeek's list price (api-docs.deepseek.com/zh-cn/quick_start/pricing).
- **packyapi** discounts the official CNY list: x0.8 in the deepseek-officially group and
  x0.5 in the deepseek-sale group. Its page renders a `$` glyph, but the numbers are the
  official yuan price x multiplier (e.g. v4-pro list ¥4.5 -> $2.25), i.e. billed in CNY.
- Both platforms currently charge **peak = idle x2** on weekdays 09:00-12:00 and
  14:00-18:00 Asia/Shanghai. The multiplier lives in the **providers** block (below), so it is
  not repeated per model; window, zone and direction can be set per platform or per model.
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

1. **Recommended**: open the badge → **Edit rates**, edit the JSON, save. Stored under the
   **dsh.token-purse.config.v3** localStorage key (v2 and v1 migrate on read).
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
      "providers": {
        "packyapi": { "peak": { "mode": "surcharge", "multiplier": 2 } },
        "deepseek-official": { "peak": { "mode": "surcharge", "multiplier": 2 } }
      },
      "models": {
        "packyapi/deepseek-flash": { "currency": "CNY", "input": 0.80, "cacheRead": 0.016, "cacheWrite": 0.80, "output": 3.20 },
        "some-gateway/night-model": {
          "currency": "CNY", "input": 1, "output": 4,
          "peak": { "mode": "discount", "multiplier": 0.25, "windows": ["Mon-Sun 00:30-08:30"] }
        },
        "flat-model": { "currency": "CNY", "input": 0.5, "output": 1, "peak": false },
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
  that fail to parse are dropped; if none parse, there is no peak pricing. The **top-level
  peak is only the default schedule** — on its own it never makes any entry peak-priced; that
  takes a multiplier.
- **providers**: platform-level schemes keyed by the provider id (the one in settings.yaml),
  each **{ "peak": { "mode": ..., "multiplier": ... } }**. Timezone and windows may be omitted,
  in which case they are inherited from the top level. When several models on one platform share
  a scheme, writing it here beats repeating it per model.
- **models[].peak** has three states: **absent** (inherit provider / top level), **false**
  (explicitly flat — stop inheriting), or an **object** (its own scheme, whose fields can still
  be inherited).
- **models**: keys may be **provider/model** (recommended) or a bare lowercase
  model id. Matching is provider/model exact, then model exact, then longest model
  substring, then fallback; provider-prefixed keys never take part in substring
  matching. So **deepseek-v4-flash-exp** hits **deepseek-v4-flash** when nothing
  more specific matches.
- **models[].currency**: the currency that entry is quoted in (CNY by default). When
  providers differ, the plugin converts through **fx** to USD and then applies
  **currency.perUsd** for display.
- Missing **cacheRead** / **cacheWrite** fall back to **input**.
- **peak.mode**: **surcharge** (the window costs more; multiplier must be **> 1**) or
  **discount** (the window costs less; multiplier must be **between 0 and 1**). The multiplier
  always applies **inside** the window; mode only sets the direction and whether the UI calls it
  peak/off-peak or discount/standard.
- **peak.multiplier**: a scalar, or an object listing **all four buckets**
  (**{ "input": 2, "cacheRead": 1, "cacheWrite": 2, "output": 4 }**). A missing bucket is
  **reported**, not silently treated as 1 — a silent default is how you misprice.
- The old **peakMultiplier** still works: **≠1** is equivalent to a surcharge scheme, **1** to
  flat pricing.
- The editor lists **configuration problems** (path + reason) beneath the JSON. Invalid values
  still fall back to something workable, but never silently: 0.1.x clamped
  **peakMultiplier: 0.5** to 1, which is exactly that trap.

### Time-of-day pricing (peak)

DeepSeek official (and packyapi, which resells it) currently charges double during weekdays
**09:00-12:00** and **14:00-18:00** (Asia/Shanghai).

Schemes are **inheritable** across three layers — **model entry → providers[platform] → top-level
peak** — with field-level fallback. The usual shape is "the platform sets the window and
multiplier; individual models are the exception":

    "providers": {
      "packyapi": { "peak": { "mode": "surcharge", "multiplier": 2 } }
    },
    "models": {
      "night-gateway/night-model": {
        "input": 1, "output": 4,
        "peak": { "mode": "discount", "multiplier": 0.25, "windows": ["Mon-Sun 00:30-08:30"] }
      },
      "flat-model": { "input": 0.5, "output": 1, "peak": false }
    }

Why three layers: **different platforms compute peak differently, and so do models within one
platform** — some add a daytime surcharge, others discount at night; the directions are opposite
and the windows do not overlap. So window, zone, direction and multiplier must each be settable
per platform or per model; a single global setting cannot express it.

- **mode** sets the direction: **surcharge** costs more inside the window (multiplier > 1),
  **discount** costs less (multiplier between 0 and 1). The multiplier always applies **inside**
  the window; outside it you pay the base price.
- **multiplier** can be per bucket, but the object must list all four; the editor flags any that
  are missing.

- Ranges are evaluated in **peak.timezone**, independent of your system zone, and
  are **half-open** (12:00 sharp already counts as off-peak); they only apply on the
  listed weekdays.
- The **badge itself shows the current mode**: a small pill next to the amount reads **Off** or
  **Peak×2** under a surcharge scheme, and **Deal×0.25** or **Std** under a discount scheme
  (hover for the windows); the panel repeats it under **Current pricing**.
- Cost is split by **when each usage increment happened**: the plugin appends every
  increase of the session totals with a timestamp to
  **dsh.token-purse.ledger.v1:<sessionId>** and prices each entry with its own
  bracket, so a cross-bracket session is summed per segment, not priced by the
  current clock.
- One approximation remains: history from before the plugin was installed, or from
  while the page was closed, has no timestamp and is priced at the bracket in effect
  when the panel first opened. A refresh does not clear the ledger (it is persisted
  per session id).
- A second known limit: amounts are recomputed from the **current** configuration, so editing a
  rate or a peak scheme **rewrites history**. If a platform swaps its whole price list on a date
  (e.g. the official 2026-09-14 routing change), that can only be calibrated by hand.

## Peak spend

The **Peak** section groups the **current session** by the rate bracket that was in
effect when each increment was observed (surcharge schemes use peak / off-peak, discount schemes
discount / standard, and there is always a flat group):

- **Peak / Discount**: inside a configured window, under a surcharge / discount scheme.
- **Off-peak / Standard**: the same model, outside the window.
- **Flat**: the model has no scheme at all (`peak: false`, or simply absent) — one price all day.

Each row shows tokens, amount, and a share bar. The section appears as soon as a session has any
time-of-day spend; if everything is flat-priced it is omitted as noise. The group amounts always
sum to the total at the top of the panel.

Matching that, any **day with banded usage** in **Daily** gets an extra line under the date
listing **whichever bands actually occurred** (`Peak ¥2.00 · Off-peak ¥1.00`, or
`Discount ¥0.50 · Standard ¥1.00` under a discount scheme) — so you can see whether moving work
off-peak actually paid off over weeks.

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
- **Open a day for the detail**: a **colour bar** comes first — each session of that day owns one
  segment, sized by its share of the day. **Hovering a segment** shows a bubble with the session,
  amount, tokens and share of that day (the hit area is taller than the 6px bar so it is easy to
  hit, and the bubble pulls itself in at the edges). Below it the sessions are listed **by session** (each
  with a matching colour swatch, labelled with the session title where available and a tooltip
  giving the project path and session id), then **by model**. The first session of a day is blue,
  then green / amber / red / deep blue / grey, wrapping after six. The colours come from static
  ramps that genuinely exist in the theme, so they read on both light and dark. A day with a single
  session and no peak usage does not expand at all, so no empty nesting appears.

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
- **How are sessions that cross brackets priced?** See **Time-of-day pricing**
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

- **0.2.0**: peak pricing became a **three-layer, inheritable scheme**; the stored config moved to
  **dsh.token-purse.config.v3** (v2 and v1 migrate on read).
  - A scheme is `{ "mode": "surcharge" | "discount", "multiplier": <scalar or four buckets>,
    "timezone"?, "windows"? }`, resolved **model → providers.<id> → top-level peak** with field-level
    fallback. **A multiplier is what turns pricing on**: a top-level schedule alone never does.
    `"peak": false` means explicitly flat, so a flat model can sit under a peak-priced platform.
    **mode** sets the direction — a surcharge multiplier must be > 1, a discount one between 0 and 1 —
    and the multiplier always applies **inside** the window.
  - **providers** is a new top-level block keyed by the provider id DSH reports (the same ids as
    settings.yaml), so a platform's scheme is written once instead of per model. It is also why the
    storage key had to change: mergeConfig drops unknown top-level keys.
  - The editor now **lists configuration problems** (path + reason, localised) beneath the JSON.
    Invalid values keep a workable fallback but are never silent again — 0.1.x clamped
    `peakMultiplier: 0.5` to 1 and said nothing. The old `peakMultiplier` is still accepted:
    `≠1` means a surcharge scheme, `1` means flat.
  - The peak/off-peak section is **mode-aware** (five bands: high / low / deal / standard / flat), and
    the badge reads *peak ×2 / off* or *deal ×0.25 / standard*.
  - Not done, on purpose: no `effectiveFrom` price switching (a platform that swaps its whole price
    list on a date still needs manual recalibration) and no per-hour price tables. For a per-bucket
    multiplier the daily and aggregate views show the **input** bucket as the representative.
- **0.1.22**: rate editing went **back to JSON only** — a structured table (one row per
  provider/model plus four number inputs) does not fit a 320px panel. The first attempt put fixed
  76px inputs on 52px tracks; switching to fluid inputs **still overlapped**, because box-sizing
  is not inherited and width:100% plus padding and border renders 12px wider than its track under
  content-box. Both were tried; this space only fits JSON. The rest of the editor work stays:
  Cancel, a two-click Reset, a >0 exchange-rate check, and JSON errors with their parse position.
  New guard: any control declaring width:100% with horizontal padding or a border must also set
  box-sizing:border-box.
- **0.1.21**: fixed the rate table overflowing (**reverted by 0.1.22**, kept for the record).
- **0.1.20**: cut the **standing prose** and improved the **rate editor**.
  - The coverage caveat dropped from a 42px paragraph to a 10px footnote under the total,
    minus the part that duplicated the subtitle; "estimate, not a bill" moved into the
    total's **title**.
  - The peak window and multiplier moved into the **Peak** tab (the trigger's tooltip already
    carried them) instead of sitting in every view.
  - Added **Cancel** — the only ways out used to be Save or Reset, so abandoning an edit meant
    wiping the config; **Reset** now needs two clicks; an exchange rate of ≤ 0 reports an error
    instead of silently becoming 1; JSON errors include the parse position.
  - The accumulated subtitle is prose, so it no longer uses the mono font; the panel title now
    carries the product name **TokenPurse**.
- **0.1.19**: **accessibility** fixes (critique P1).
  - The two identical-looking segmented bars actually mean different things: **Scope** is now a
    radiogroup (it switches a mode, not a panel) and **View** completes the tabs pattern —
    aria-label, aria-controls, tabpanel + aria-labelledby, roving tabindex.
  - Both respond to **← → / Home / End**, moving selection and focus together, so **Tab** stops
    on the current option only.
  - The panel went from role=dialog to disclosure semantics — it is neither modal nor does it
    take focus.
  - The sparkline gained a **:focus-visible** outline, and its readout is announced by a
    permanent live region: the bubble only mounts while hovering, and screen readers usually
    do not announce a region that appears together with its content.
  - Hit targets were brought up to 24px (WCAG 2.2 SC 2.5.8); the currency select gained an
    accessible name; error-text and label-tertiary contrast issues were fixed.
- **0.1.18**: the panel is capped at **max-height: min(72vh, 600px)** with a sticky header and
  scrolls internally instead of growing off-screen; the colour-block bubble no longer overflows
  sideways; motion follows **prefers-reduced-motion**.
- **0.1.17**: the colour bar is now **hoverable** — pointing at a segment shows a bubble with the
  session, amount, tokens and that day's share. The hit area is a 14px transparent layer over the
  6px bar (easier to hit than the bar itself), positioned from the same percentages that drive
  flexGrow, so the zones line up with the visible blocks; the bubble pulls itself in at the edges.
  With nothing hovered only the hit zones render, no bubble.
- **0.1.16**: fixed the **sparkline area rendering black**. Its fill referenced
  --dsw-alias-fill-l2, which **does not exist** in the theme — in a background position the failure
  is merely transparent, but in a fill position fill is inherited, so the invalid value falls back
  to the inherited/initial **black** and the daily chart drew a solid black wedge. Now uses the real
  --dsw-alias-label-tertiary with fill-opacity:.16. Two other missing tokens (--dsw-font-mono,
  --dsw-static-yellow-500) remain but are harmless: they either carry a fallback or degrade to
  invisible.
- **0.1.15**: opening a day in **Daily** now leads with that day's **sessions**: a **colour bar**
  splits the day into one segment per session, sized by share, and the rows below list **by
  session** (each with its colour swatch) and then **by model**. Session labels use the session
  title where available, with the project path and session id in the tooltip. All six palette
  entries were checked against the theme — they are static ramps that genuinely exist (the panel
  had been referencing three tokens that do not: fill-l2, font-mono, yellow-500). Only days with
  more than one session expand.
- **0.1.14**: All time gained a **Projects** tab that lists spend per **project → session**:
  a project row shows its directory name, tokens, amount and share bar, and expanding it lists
  each session under it (using the session title when available). The project comes from the
  session's working directory and is stored with every record (older rows start under "Unknown
  project" and are corrected when that session is next opened).
- **0.1.13**: fixed **All time being wiped by a stale page**. The merge now **re-reads
  localStorage** before writing back; previously it overwrote the store with its in-memory copy,
  so a second tab (or a forgotten old page) could write back a snapshot that predated other
  sessions and erase them — which looks exactly like "All time only has the current session".
  Rows with a missing session id are also normalised to one placeholder key (they used to never
  match, so they were re-added forever instead of replaced), and the panel is keyed by session
  (`key={sessionId}`) so ledger state cannot carry over. A regression test using a mini React
  that **actually runs effects** now locks the behaviour down.
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