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
- Bottom of the panel: **Edit rates** — override the default rates and currency
  as JSON, stored in the browser's localStorage.
- Nothing renders until the session has billed at least one token, so an empty
  session stays clean.

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

1. Add the package to the profile:

        dsh plugin --profile web add file:/Users/a/Desktop/dev/iptodays/dsh-plugins/token-purse

   Or manually:

        cd "$DSH_HOME/profiles/web"
        pnpm add file:/Users/a/Desktop/dev/iptodays/dsh-plugins/token-purse

2. Insert this into the top-level array of
   **$DSH_HOME/profiles/web/cordis.patch.yml**:

        - insert:
            - id: ui-token-purse
              name: '@dsh-plugins/token-purse'

3. Save. patchReload is live, so it picks the change up; refresh the page and send
   a message — the **≈$...** badge appears in the stats row under the composer.

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
      "ui": { "peakSplit": true },
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
- **ui.peakSplit**: state of the panel's **Split** switch (default **true**). Turn it off to
  hide the peak/off-peak amount split.
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
- A **Split** switch in the panel adds a line breaking the total down by bracket, e.g.
  **Peak ¥1.60 · Off-peak ¥0.80** (only non-zero sides are shown). This summarises the
  **time-segmented** calculation; the preference lives in **ui.peakSplit**.
- Cost is split by **when each usage increment happened**: the plugin appends every
  increase of the session totals with a timestamp to
  **dsh.token-purse.ledger.v1:<sessionId>** and prices each entry with its own
  bracket, so a cross-bracket session is summed per segment, not priced by the
  current clock.
- One approximation remains: history from before the plugin was installed, or from
  while the page was closed, has no timestamp and is priced at the bracket in effect
  when the panel first opened. A refresh does not clear the ledger (it is persisted
  per session id).

## Currency

The lower half of the popover has **Currency** and **Rate** rows:

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