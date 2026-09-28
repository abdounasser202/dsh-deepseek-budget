# dsh-deepseek-budget

A DeepSeek spend meter. It answers two questions: **what did this machine consume**,
and **how much of the company budget is gone?**

It reads the provider-reported token usage that each coding harness on this machine
already writes into its own session logs, and prices it at DeepSeek list rates. It
never calls the DeepSeek API and holds no credential, so it works with a shared API
key — unlike dashboards that need a `platform.deepseek.com` login.

**It counts every harness on the machine, not just DSH.** Counting only one harness
understates the real spend — by 3.5× on this machine, where the deeper subagent
transcripts hid most of the usage.

## How it finds usage

DSH keeps a dedicated adapter, because its log is zstd-compressed and carries stream
timing. Everything else is found by **content discovery**: the plugin walks the home
directory, keeps any `.json`/`.jsonl` file whose bytes contain `deepseek`, and parses it
with one generic record reader that understands the provider/model/usage shapes every
harness writes.

That means **a harness nobody anticipated is still counted**, and a log that merely
mentions DeepSeek in prose is not — the parser only accepts records that carry token
usage on a DeepSeek route.

| Harness seen on this machine | DeepSeek calls |
| --- | --- |
| DSH | ✅ counted (dedicated adapter) |
| Pi (incl. every subagent transcript) | ✅ counted (discovery) |
| Claude Code, Codeg, Copilot, opencode | ❌ installed, but no DeepSeek calls |

Only DeepSeek routes are counted. A harness that also drives Claude or a local model
contributes just its DeepSeek calls; everything else is reported separately and kept out
of the budget.

### Duplicates

A harness may write the same call into two files — a subagent's transcript and its parent
session. Copies are collapsed globally by the provider's own response id, falling back to
a strict fingerprint of time, route and token counts. On this machine that removed 593 of
1,419 Pi records; the raw count would have overstated spend by 72%.

## What it measures

| Figure | Source |
| --- | --- |
| Cache-hit and cache-miss input tokens | `cacheReadTokens`/`cacheRead`/`cached_tokens`, `inputTokens`/`input`/`prompt_tokens` |
| Output and reasoning tokens | `outputTokens`/`output`/`completion_tokens`, `reasoningTokens`/`reasoning` |
| Cost | DeepSeek list prices, peak/off-peak, per model |
| Time to first token, call duration | Timestamps in the recorded response stream (DSH only) |
| Output speed | Output tokens over call duration |

Token counts are exact: they are the numbers the API itself reported. Costs are
list-price calculations, not invoice amounts.

### Billing basis

Costs always use DeepSeek's **published list prices**, because that is what the
account is billed. A harness's own recorded cost is surfaced separately as a
cross-check — harnesses ship older rate tables and read lower. For one day's calls:
**$1.5270 at list prices** versus **~$1.26 as recorded by the harnesses**.
Budget on the higher figure.

## Where to see it

- **Settings → DeepSeek Budget** in the DSH web GUI: budget gauge, window
  selector (Today / 7 days / 30 days / All), cost by model, cost by day,
  cache-hit rate, and speed. Refreshes every 30 seconds.
- **`deepseek_usage` tool**: lets the agent report its own consumption in a turn.
- **`GET /deepseek-budget/report?window=all`**: local usage as raw JSON.
- **`GET /deepseek-budget/account`**: company account and budget progress as raw JSON.
  Both routes are loopback guarded.

## Company account (all developers, all API keys)

Local logs can only ever describe this machine. The company budget needs the provider,
so the panel shows a second, clearly separated section:

| Figure | Source | Needs |
| --- | --- | --- |
| Account balance, per currency | `GET /user/balance` | API key |
| Whole-account spend this month | platform `usage/cost` | **user token** |
| Whole-account tokens this month | platform `usage/amount` | **user token** |
| Budget progress | the two above | user token |

**The platform usage endpoints do not accept the API key.** They require a
`platform.deepseek.com` user token, which only an account owner can mint. So the balance
works for everyone, while whole-account spend appears only when that token is present —
otherwise the panel says why instead of guessing.

Supply the token as the DSH credential `DEEPSEEK_USER_TOKEN`, or as that environment
variable.

### Budget and currency

`DEEPSEEK_BUDGET_EUR` sets the budget (default `50`). The account bills in its own
currency, so the budget is converted for the progress figure using
`DEEPSEEK_USD_PER_EUR` (default `1.08`) and `DEEPSEEK_CNY_PER_EUR` (default `7.8`).
A currency with no configured rate shows the spend with **no** fraction, never a wrong one.

## Portability

Built to be handed to a colleague whose machine looks nothing like yours:

- **No DSH dependency.** `sessionPersistence` is queried, not injected, so the plugin
  loads and measures where DSH has never run. The DSH adapter reports "not present".
- **Roots are configurable.** `DEEPSEEK_BUDGET_ROOTS` (colon/comma separated) or
  `DEEPSEEK_BUDGET_HOME` when a log store lives elsewhere.
- **No harness is named.** Discovery is by content and parsing is generic, so a tool
  released tomorrow is found and read by the same rules.
- **Shapes are tolerated, not assumed.** Records flat or nested under
  `message`/`response`/`data`/`record`; counters named `inputTokens`/`input`/
  `prompt_tokens` and friends, cache detail inline or in `prompt_tokens_details`;
  timestamps in seconds, ms, µs, ISO, or on a container field; a single-document log
  (array, or a `records`/`messages`/`events` field) is read too.

**What it cannot see:** usage kept only in a database (opencode stores messages in
SQLite), a call that leaves no local log at all, or a colleague's other machine. The
company account section covers the last of these when a user token is configured.

## Pricing model

Rates are USD per 1M tokens, from the DeepSeek pricing page.

| | deepseek-flash | deepseek-v4-pro |
| --- | --- | --- |
| Input, cache hit (off-peak / peak) | $0.003 / $0.006 | $0.022 / $0.044 |
| Input, cache miss (off-peak / peak) | $0.15 / $0.30 | $0.66 / $1.32 |
| Output (off-peak / peak) | $0.60 / $1.20 | $1.98 / $3.96 |

Peak is UTC 01:00–04:00 and 06:00–10:00, Monday to Friday, excluding Chinese
public holidays. Off-peak is everything else, including weekends. A cache write
is billed at the miss rate.

`deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are retired names billed
as Flash, and are priced as such.

To change the budget, edit `BUDGET_USD` in `lib/index.js`. To add a model, add an
entry to `PRICING`.

**Update the holiday table each January.** `CN_HOLIDAYS` covers 2026–2027 only.
A later year falls back to the weekday rule, which misprices those holiday days
by at most 2x and affects no other day.

## Install

Linked into the `web` profile from this directory, so edits here take effect and
the source stays in the repo:

```bash
dsh plugin --profile web add link:$(pwd)
```

Then restart DSH. Remove with `dsh plugin --profile web remove dsh-deepseek-budget`.

## Writing the client half

Two different `inject` lists exist, and mixing them up silently breaks the panel:

| Field | What it lists | Example |
| --- | --- | --- |
| `dsh.client.inject` in `package.json` | **Package specifiers** the bundle `require()`s | `@deepseek-ai/dsh-client-ui-slots` |
| `exports.inject` in `lib/client.js` | **Cordis service names** the plugin waits for | `['slots', 'timer']` |

This plugin's bundle needs only the `react` seed, so `dsh.client` declares just
`platform`. Service names belong in `exports.inject`; putting them in
`dsh.client.inject` makes the module system queue packages that do not exist and
the plugin never materializes.

## Scope and limits

- **This machine's API key usage only.** If the key is shared across the team,
  the company console is the only place the combined total appears.
- **Costs are list prices.** Different account terms would shift the numbers.
- **Timing includes the network**, so speed figures are not a model-quality
  metric and vary with prompt size.
- Sessions are read through `sessionPersistence`, so the newest few seconds of a
  live session may not appear until its next durability checkpoint.
