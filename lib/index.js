// dsh-deepseek-budget — host half.
//
// Measures real DeepSeek API spend against a USD budget. The source of truth is
// the provider-reported token usage that DSH writes into its own durable session
// logs: `assistant/message` events carry `usage`, where `inputTokens` counts
// cache MISSES and `cacheReadTokens` counts cache HITS. Nothing is estimated.
//
// No credential is read: this plugin never calls the DeepSeek API, it only reads
// local session logs. That is what makes it work with a shared API key, unlike
// dashboards that require a platform.deepseek.com login.
//
// Deliberately dependency-free: no `@deepseek-ai/*` import, so the package loads
// wherever the Cordis Loader puts it.

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'deepseek-budget'
// `sessionPersistence` is deliberately NOT a hard dependency: the plugin must
// load and measure on a machine that never ran DSH.
export const inject = ['tools', 'webServer']
// `credentials` is queried, not injected: without it the plugin still measures
// local usage, it just cannot read the company account.

const PLUGIN_NAME = 'deepseek-budget'
const BUDGET_USD = 10
const USD_PER_MTOK = 1_000_000
const ROUTE_PATH = '/deepseek-budget/report'
const TOOL_NAME = 'deepseek_usage'
const ACCOUNT_ROUTE = '/deepseek-budget/account'

// ---- company account (key-wide, not machine-local) ----
//
// Local logs only ever describe THIS machine. The account-wide picture needs the
// provider: the balance endpoint takes the API key every user already has, while
// the usage endpoints need a platform.deepseek.com user token that only an
// account owner can mint.
const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const USAGE_COST_URL = 'https://platform.deepseek.com/api/v0/usage/cost'
const USAGE_AMOUNT_URL = 'https://platform.deepseek.com/api/v0/usage/amount'
const ACCOUNT_TIMEOUT_MS = 15_000
const API_KEY_REF = 'DEEPSEEK_API_KEY'
const USER_TOKEN_REF = 'DEEPSEEK_USER_TOKEN'

/**
 * The company budget, in EUR, and the rate used to compare it with costs.
 *
 * intentional: a fixed configurable rate rather than a live FX feed — the budget
 * is a planning number, and a stale rate moves it by a fraction of a percent,
 * while a network dependency would make the whole panel fail offline.
 */
const BUDGET_EUR = Number(process.env.DEEPSEEK_BUDGET_EUR ?? 50)

/**
 * Units of a currency per 1 EUR, used only to compare a foreign-currency bill
 * against a EUR budget. Override per deployment rather than editing code.
 */
function currencyRates() {
  return {
    EUR: 1,
    USD: Number(process.env.DEEPSEEK_USD_PER_EUR ?? 1.08),
    CNY: Number(process.env.DEEPSEEK_CNY_PER_EUR ?? 7.8),
  }
}

/** Currency the provider reports for spend, and the EUR budget expressed in it. */
function budgetInCurrency(currency, rates) {
  if (typeof currency !== 'string' || currency.length === 0) return null
  const rate = rates[currency]
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return null
  return BUDGET_EUR * rate
}

/**
 * DeepSeek list prices in USD per 1M tokens. Off-peak is half of peak.
 *
 * Peak is UTC 01:00-04:00 and 06:00-10:00, Monday through Friday, excluding
 * Chinese public holidays. A cache write is billed at the miss rate.
 */
const PRICING = {
  'deepseek-official': {
    'deepseek-flash': {
      label: 'DeepSeek-V4.1-Flash',
      cacheHit: { peak: 0.006, offPeak: 0.003 },
      cacheMiss: { peak: 0.3, offPeak: 0.15 },
      output: { peak: 1.2, offPeak: 0.6 },
    },
    'deepseek-v4-pro': {
      label: 'DeepSeek-V4-Pro-0813',
      cacheHit: { peak: 0.044, offPeak: 0.022 },
      cacheMiss: { peak: 1.32, offPeak: 0.66 },
      output: { peak: 3.96, offPeak: 1.98 },
    },
  },
}

/** Retired model ids are still billed as Flash. */
const PRICE_ALIAS = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
}

/**
 * Chinese public holidays are off-peak in full.
 *
 * intentional: the table covers 2026-2027 only. A later year falls back to the
 * weekday rule, which misprices those holiday days by the peak/off-peak ratio
 * (2x at most) and never affects any other day. Extend the table each January.
 */
const CN_HOLIDAYS = new Set([
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20',
  '2026-02-21', '2026-02-22', '2026-04-05', '2026-05-01', '2026-06-19', '2026-09-25',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06',
  '2026-10-07',
  '2027-01-01', '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09',
  '2027-02-10', '2027-02-11', '2027-04-05', '2027-05-01', '2027-06-09', '2027-09-15',
  '2027-10-01', '2027-10-02', '2027-10-03', '2027-10-04', '2027-10-05', '2027-10-06',
  '2027-10-07',
])

const DAY_MS = 86_400_000

function pad(value) {
  return value < 10 ? `0${value}` : String(value)
}

/** UTC day key, `YYYY-MM-DD`. */
function dayKey(ms) {
  const date = new Date(ms)
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/** Whether a call at `ms` is billed at peak rates. */
function isPeak(ms) {
  const date = new Date(ms)
  const weekday = date.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  if (CN_HOLIDAYS.has(dayKey(ms))) return false
  const hour = date.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
}

/** Resolve the price entry for one provider route and model, if priced. */
function priceFor(provider, model) {
  const table = PRICING[provider]
  if (table === undefined) return undefined
  return table[model] ?? table[PRICE_ALIAS[model]]
}

/**
 * Map every local harness's route onto this plugin's canonical DeepSeek route.
 *
 * DSH reports `deepseek-official`; Pi reports `deepseek`. Both serve the same
 * DeepSeek models, so they must price identically. Returns undefined for routes
 * that are not DeepSeek (an Anthropic or local model must never enter the total).
 */
function canonicalRoute(provider, model) {
  const providerName = String(provider ?? '').toLowerCase()
  const modelName = String(model ?? '')
  const isDeepSeek = providerName.includes('deepseek')
    || modelName.toLowerCase().includes('deepseek')
  if (!isDeepSeek) return undefined

  // Vendors spell the same model several ways: namespaced
  // (`accounts/acme/models/deepseek-v4-pro-0813`) and version-suffixed
  // (`deepseek-v4-pro-0813`). Normalise to the id the price table knows.
  let bare = modelName.replace(/^.*\//, '')
  for (const known of deepSeekModelIds()) {
    if (bare.startsWith(known)) {
      bare = known
      break
    }
  }
  return { provider: 'deepseek-official', model: PRICE_ALIAS[bare] ?? bare }
}

/** Every model id this plugin can price, longest first so prefixes match exactly. */
function deepSeekModelIds() {
  const ids = []
  for (const table of Object.values(PRICING)) {
    for (const id of Object.keys(table)) ids.push(id)
  }
  ids.push(...Object.keys(PRICE_ALIAS))
  return ids.sort((left, right) => right.length - left.length)
}

/** Price one call's usage. Returns null when the route is not a DeepSeek route. */
function priceCall(provider, model, usage, atMs) {
  const route = canonicalRoute(provider, model)
  if (route === undefined) return null
  return priceRouteCall(route, usage, atMs)
}

/** Price one call on an already-canonical route. */
function priceRouteCall(route, usage, atMs) {
  const price = priceFor(route.provider, route.model)
  if (price === undefined) return null
  const band = isPeak(atMs) ? 'peak' : 'offPeak'
  const uncachedInput = usage.inputTokens || 0
  const cacheRead = usage.cacheReadTokens || 0
  const cacheWrite = usage.cacheWriteTokens || 0
  const output = usage.outputTokens || 0
  const cost = (
    uncachedInput * price.cacheMiss[band]
    + cacheRead * price.cacheHit[band]
    + cacheWrite * price.cacheMiss[band]
    + output * price.output[band]
  ) / USD_PER_MTOK
  return { cost, band, uncachedInput, cacheRead, cacheWrite, output }
}

/**
 * Reconstruct per-call stream timing from the compacted stream records.
 *
 * Text and reasoning records store `time0` plus a delta array, so each delta
 * start is `time0` plus the running sum. Records without timing yield null.
 */
function streamTiming(records) {
  if (!Array.isArray(records) || records.length === 0) return null
  let first = null
  let firstText = null
  let last = null
  for (const record of records) {
    if (typeof record.time === 'number') {
      if (first === null || record.time < first) first = record.time
      if (last === null || record.time > last) last = record.time
    }
    if (typeof record.time0 === 'number') {
      let cursor = record.time0
      if (first === null || cursor < first) first = cursor
      if (last === null || cursor > last) last = cursor
      if (Array.isArray(record.dt)) {
        for (const delta of record.dt) {
          cursor += Math.max(0, Number(delta) || 0)
          if (last === null || cursor > last) last = cursor
        }
      }
      if (firstText === null) firstText = record.time0
    }
  }
  if (first === null || last === null) return null
  return { start: first, firstText, end: last }
}

function emptyTotals() {
  return {
    calls: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costUSD: 0,
    costAtPeakUSD: 0,
    costAtOffPeakUSD: 0,
    peakCalls: 0,
    offPeakCalls: 0,
    ttftSumMs: 0,
    ttftSamples: 0,
    durationSumMs: 0,
    durationSamples: 0,
  }
}

function addCall(totals, call) {
  totals.calls += 1
  totals.uncachedInputTokens += call.uncachedInput
  totals.cacheReadTokens += call.cacheRead
  totals.cacheWriteTokens += call.cacheWrite
  totals.outputTokens += call.output
  totals.reasoningTokens += call.reasoningTokens
  totals.totalTokens += call.uncachedInput + call.cacheRead + call.cacheWrite + call.output
  totals.costUSD += call.cost
  if (call.band === 'peak') {
    totals.costAtPeakUSD += call.cost
    totals.peakCalls += 1
  } else {
    totals.costAtOffPeakUSD += call.cost
    totals.offPeakCalls += 1
  }
  if (call.ttftMs !== null) {
    totals.ttftSumMs += call.ttftMs
    totals.ttftSamples += 1
  }
  if (call.durationMs !== null) {
    totals.durationSumMs += call.durationMs
    totals.durationSamples += 1
  }
}

/** Fold raw counters into the report-facing shape. */
function summarize(totals) {
  const inputTokens = totals.uncachedInputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
  return {
    calls: totals.calls,
    uncachedInputTokens: totals.uncachedInputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    outputTokens: totals.outputTokens,
    reasoningTokens: totals.reasoningTokens,
    inputTokens,
    totalTokens: totals.totalTokens,
    cacheHitRate: inputTokens > 0 ? totals.cacheReadTokens / inputTokens : 0,
    costUSD: totals.costUSD,
    costAtPeakUSD: totals.costAtPeakUSD,
    costAtOffPeakUSD: totals.costAtOffPeakUSD,
    peakCalls: totals.peakCalls,
    offPeakCalls: totals.offPeakCalls,
    avgTtftMs: totals.ttftSamples > 0 ? totals.ttftSumMs / totals.ttftSamples : null,
    ttftSamples: totals.ttftSamples,
    avgDurationMs: totals.durationSamples > 0 ? totals.durationSumMs / totals.durationSamples : null,
    outputTokensPerSecond: totals.durationSamples > 0 && totals.durationSumMs > 0
      ? totals.outputTokens / (totals.durationSumMs / 1000)
      : null,
  }
}

/**
 * Extract one priced call per model request from a session's event log.
 *
 * `request/context` supplies the routed model when the message source lacks it;
 * `step/start` supplies the request start used for time-to-first-token.
 */
function extractCalls(events) {
  const calls = []
  const contextByStep = new Map()
  const stepStart = new Map()
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const data = event.data
    if (data === null || typeof data !== 'object') continue
    const stepKey = `${data.turn}:${data.step}`
    if (event.type === 'step/start') {
      stepStart.set(stepKey, event.time)
      continue
    }
    if (event.type === 'request/context') {
      contextByStep.set(stepKey, { provider: data.provider, model: data.model })
      continue
    }
    if (event.type !== 'assistant/message') continue
    const usage = data.usage
    if (usage === null || typeof usage !== 'object') continue
    const source = data.message?.source ?? {}
    const context = contextByStep.get(stepKey) ?? {}
    const provider = source.provider ?? context.provider ?? 'unknown'
    const model = source.model ?? context.model ?? 'unknown'
    const canonical = canonicalRoute(provider, model)
    const priced = canonical === undefined ? null : priceRouteCall(canonical, usage, event.time)
    const timing = streamTiming(data.stream)
    const origin = stepStart.get(stepKey) ?? timing?.start ?? event.time
    calls.push({
      source: 'dsh',
      dedupKey: data.responseId ?? null,
      time: event.time,
      provider,
      model,
      canonicalProvider: canonical?.provider ?? null,
      canonicalModel: canonical?.model ?? null,
      uncachedInput: usage.inputTokens || 0,
      cacheRead: usage.cacheReadTokens || 0,
      cacheWrite: usage.cacheWriteTokens || 0,
      output: usage.outputTokens || 0,
      reasoningTokens: usage.reasoningTokens || 0,
      band: priced === null ? null : priced.band,
      cost: priced === null ? 0 : priced.cost,
      priced: priced !== null,
      ttftMs: timing?.firstText != null ? timing.firstText - origin : null,
      durationMs: timing === null ? null : timing.end - origin,
    })
  }
  return calls
}

/**
 * One record's usage, normalized from whatever field names a harness wrote.
 *
 * Harnesses disagree on spelling (`inputTokens` vs `input` vs `prompt_tokens`)
 * and on whether the prompt total already includes cache hits, so the cache
 * portion is always subtracted out to leave a true uncached count.
 *
 * @returns the normalized counts, or null when the record carries no usage.
 */
function normalizeUsage(usage) {
  if (usage === null || typeof usage !== 'object') return null
  const first = (...values) => values.find((value) => typeof value === 'number' && Number.isFinite(value))
  // Wire formats nest cache detail one level down, in either spelling.
  const details = usage.prompt_tokens_details ?? usage.input_tokens_details ?? {}
  const cacheRead = first(
    usage.cacheReadTokens, usage.cache_read_tokens, usage.cacheRead,
    usage.cached_tokens, details.cached_tokens,
    0,
  )
  // A wire "prompt tokens" total already contains the cached portion; the
  // single-name spellings do not.
  const wireTotal = first(usage.prompt_tokens, usage.input_tokens, undefined)
  let uncachedInput = first(usage.inputTokens, usage.input, usage.prompt_tokens, wireTotal)
  if (uncachedInput === undefined) return null
  if (wireTotal !== undefined && uncachedInput === wireTotal) {
    uncachedInput = Math.max(0, uncachedInput - cacheRead)
  }
  const output = first(usage.outputTokens, usage.output, usage.completion_tokens, 0)
  const cacheWrite = first(usage.cacheWriteTokens, usage.cacheWrite, 0)
  const reasoning = first(usage.reasoningTokens, usage.reasoning, 0)
  if (uncachedInput === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return null
  return { uncachedInput, cacheRead, cacheWrite, output, reasoning }
}

/** The recorded cost a harness wrote itself, when it wrote one. */
function recordedCostOf(usage) {
  if (usage === null || typeof usage !== 'object') return 0
  const cost = usage.cost
  if (cost === null || typeof cost !== 'object') return 0
  const total = cost.total
  return typeof total === 'number' && Number.isFinite(total) ? total : 0
}

/**
 * Candidate subjects of one record, most specific first: a harness may nest the
 * turn under `message`, `response`, `data` or `record`, or write it flat.
 */
function recordSubjects(record) {
  const candidates = [record.message, record.response, record.data, record.record, record]
  return candidates.filter((value) => value !== null && typeof value === 'object' && !Array.isArray(value))
}

/**
 * Read one record from ANY harness into this plugin's call shape.
 *
 * The turn may be nested or flat, and the provider's usage may be wrapped in
 * `{ type: 'usage', usage }`. No harness is named here: a tool written tomorrow
 * is read by these same rules.
 *
 * @returns a call, or null when the record is not a priced DeepSeek turn.
 */
function parseCallRecord(record, fallbackAt) {
  if (record === null || typeof record !== 'object') return null
  if (!Number.isFinite(fallbackAt)) return null

  for (const message of recordSubjects(record)) {
    if (typeof message.provider !== 'string' && typeof message.model !== 'string') continue
    const canonical = canonicalRoute(message.provider, message.model)
    if (canonical === undefined) continue

    const wrapped = message.usage !== null && typeof message.usage === 'object' && message.usage.usage !== undefined
    const usage = wrapped ? message.usage.usage : message.usage
    // A harness may box its counters in `usage`, or write them flat on the turn.
    const normalized = normalizeUsage(usage) ?? normalizeUsage(message)
    if (normalized === null) continue

    const priced = priceRouteCall(canonical, {
      inputTokens: normalized.uncachedInput,
      cacheReadTokens: normalized.cacheRead,
      cacheWriteTokens: normalized.cacheWrite,
      outputTokens: normalized.output,
    }, fallbackAt)
    return {
      source: 'log',
      // A harness may write one call into two files (a parent session and a
      // subagent transcript), so keep the provider's own id when it has one.
      dedupKey: message.responseId ?? record.responseId ?? null,
      time: fallbackAt,
      provider: message.provider ?? 'deepseek',
      model: message.model ?? 'unknown',
      canonicalProvider: canonical.provider,
      canonicalModel: canonical.model,
      uncachedInput: normalized.uncachedInput,
      cacheRead: normalized.cacheRead,
      cacheWrite: normalized.cacheWrite,
      output: normalized.output,
      reasoningTokens: normalized.reasoning,
      band: priced === null ? null : priced.band,
      cost: priced === null ? 0 : priced.cost,
      recordedCost: recordedCostOf(usage ?? message),
      priced: priced !== null,
      ttftMs: null,
      durationMs: null,
    }
  }
  return null
}

/**
 * Timestamp in ms from any of the spellings harnesses use.
 *
 * Every candidate subject is searched, because a wrapper often carries the time
 * while the nested turn carries the usage.
 */
function timestampOf(record) {
  for (const subject of recordSubjects(record)) {
    for (const value of [subject.timestamp, subject.time, subject.ts, subject.createdAt, subject.created_at]) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        // Seconds, milliseconds and microseconds are all seen in the wild.
        if (value > 1e14) return Math.round(value / 1000)
        return value < 1e12 ? value * 1000 : value
      }
      if (typeof value === 'string' && value.length > 0) {
        if (/^\d+$/.test(value)) {
          const numeric = Number(value)
          if (numeric > 1e14) return Math.round(numeric / 1000)
          return numeric < 1e12 ? numeric * 1000 : numeric
        }
        const parsed = Date.parse(value)
        if (Number.isFinite(parsed)) return parsed
      }
    }
  }
  return null
}

/**
 * Parse a harness log that holds JSON records.
 *
 * Line-delimited records are the common case; blank and malformed lines are
 * skipped so a torn tail never costs the whole file. A log that is instead one
 * JSON document — an array of records, or a records/messages/events field — is
 * read too, so a harness that dumps a single file is not missed.
 */
function parseJsonRecords(text) {
  const calls = []
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let record
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }
    const call = parseCallRecord(record, timestampOf(record))
    if (call !== null) calls.push(call)
  }
  if (calls.length > 0) return calls

  let document
  try {
    document = JSON.parse(String(text))
  } catch {
    return calls
  }
  const collections = []
  if (Array.isArray(document)) collections.push(document)
  for (const key of ['records', 'documents', 'messages', 'events', 'entries', 'items', 'turns', 'calls']) {
    if (Array.isArray(document?.[key])) collections.push(document[key])
  }
  for (const collection of collections) {
    for (const entry of collection) {
      const call = parseCallRecord(entry, timestampOf(entry))
      if (call !== null) calls.push(call)
    }
    if (calls.length > 0) break
  }
  return calls
}

/** Parse one Pi session log. Kept as a named entry point for the tests. */
function parsePiSession(text) {
  return parseJsonRecords(text)
}


/** UTC midnight of the day containing `ms`. */
function dayStart(ms) {
  const date = new Date(ms)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

/** Resolve a named window into an inclusive time range. */
function resolveWindow(name, now) {
  if (name === 'today') return { from: dayStart(now), to: now }
  if (name === '7d') return { from: now - 7 * DAY_MS, to: now }
  if (name === '30d') return { from: now - 30 * DAY_MS, to: now }
  return { from: 0, to: now }
}

/** Aggregate calls into the report the panel and the Tool both consume. */
function buildReport(calls, window, now) {
  const selected = calls.filter((call) => call.time >= window.from && call.time <= window.to)
  const totals = emptyTotals()
  const unpricedTotals = emptyTotals()
  const byModel = new Map()
  const byDay = new Map()

  for (const call of selected) {
    addCall(call.priced ? totals : unpricedTotals, call)
    const modelKey = `${call.canonicalProvider ?? call.provider}/${call.canonicalModel ?? call.model}`
    if (!byModel.has(modelKey)) {
      byModel.set(modelKey, {
        provider: call.canonicalProvider ?? call.provider,
        model: call.canonicalModel ?? call.model,
        actualProvider: call.provider,
        actualModel: call.model,
        priced: call.priced,
        totals: emptyTotals(),
      })
    }
    addCall(byModel.get(modelKey).totals, call)
    const day = dayKey(call.time)
    if (!byDay.has(day)) byDay.set(day, emptyTotals())
    addCall(byDay.get(day), call)
  }

  const summary = summarize(totals)
  const unpriced = summarize(unpricedTotals)
  const remaining = BUDGET_USD - summary.costUSD

  return {
    budgetUSD: BUDGET_USD,
    window: { name: window.name, from: window.from, to: window.to },
    totals: summary,
    // Every harness that reported a recorded cost for these calls. Pi prices
    // Flash at roughly half the published rates, so this figure is a cross-check
    // on the billing basis, never a replacement for it.
    recordedCostUSD: selected.reduce((sum, call) => sum + (call.recordedCost ?? 0), 0),
    sources: window.sources ?? [],
    unpriced: { calls: unpriced.calls, totalTokens: unpriced.totalTokens },
    budget: {
      spentUSD: summary.costUSD,
      remainingUSD: remaining,
      usedFraction: BUDGET_USD > 0 ? summary.costUSD / BUDGET_USD : 0,
      overBudget: remaining < 0,
    },
    headline: {
      avgCostPerCallUSD: summary.calls > 0 ? summary.costUSD / summary.calls : 0,
      // Billable input excludes cache reads: a cache hit is nearly free, so
      // counting it would make this average read as millions of tokens a call.
      avgBillableTokensPerCall: summary.calls > 0
        ? (summary.uncachedInputTokens + summary.outputTokens) / summary.calls
        : 0,
      avgTokensPerCall: summary.calls > 0 ? summary.totalTokens / summary.calls : 0,
      callsRemainingInBudget: summary.calls > 0 && summary.costUSD > 0
        ? Math.floor((remaining / summary.costUSD) * summary.calls)
        : null,
    },
    models: [...byModel.values()]
      .map((entry) => ({
        provider: entry.provider,
        model: entry.model,
        priced: entry.priced,
        label: priceFor(entry.provider, entry.model)?.label ?? null,
        totals: summarize(entry.totals),
      }))
      .sort((left, right) => right.totals.costUSD - left.totals.costUSD),
    days: [...byDay.entries()]
      .map(([day, dayTotals]) => ({ day, totals: summarize(dayTotals) }))
      .sort((left, right) => (left.day < right.day ? 1 : -1)),
  }
}

function usd(value) {
  const amount = Number(value) || 0
  if (amount === 0) return '$0.00'
  if (amount < 0.01) return `$${amount.toFixed(4)}`
  return `$${amount.toFixed(2)}`
}

function tok(value) {
  const amount = Number(value) || 0
  if (amount >= 1e6) return `${(amount / 1e6).toFixed(2)}M`
  if (amount >= 1e3) return `${(amount / 1e3).toFixed(1)}k`
  return String(Math.round(amount))
}

/** Render the report as the text a model sees for the Tool call. */
function renderReport(value) {
  const totals = value?.totals ?? {}
  const budget = value?.budget ?? {}
  const lines = [
    `DeepSeek budget: ${usd(budget.spentUSD)} of ${usd(value?.budgetUSD)} `
    + `(${((Number(budget.usedFraction) || 0) * 100).toFixed(2)}% used, ${usd(budget.remainingUSD)} left)`,
    `Window: ${value?.window?.name ?? 'all'}`,
    `Calls: ${totals.calls || 0} | input ${tok(totals.inputTokens)} tokens `
    + `(${((Number(totals.cacheHitRate) || 0) * 100).toFixed(1)}% cache hits) `
    + `| output ${tok(totals.outputTokens)} tokens | reasoning ${tok(totals.reasoningTokens)} tokens`,
    `Speed: ${totals.avgTtftMs == null ? 'n/a' : `${Math.round(totals.avgTtftMs)} ms`} avg time to first token `
    + `| ${totals.outputTokensPerSecond == null ? 'n/a' : `${Number(totals.outputTokensPerSecond).toFixed(1)} tok/s`} output `
    + `| ${totals.avgDurationMs == null ? 'n/a' : `${Math.round(totals.avgDurationMs)} ms`} avg call`,
    `Peak-hour calls: ${totals.peakCalls || 0} (${usd(totals.costAtPeakUSD)}) `
    + `| off-peak: ${totals.offPeakCalls || 0} (${usd(totals.costAtOffPeakUSD)})`,
    `Average cost per call: ${usd(value?.headline?.avgCostPerCallUSD)}`,
  ]
  for (const entry of value?.models ?? []) {
    lines.push(
      `  - ${entry.model}: ${entry.totals.calls} calls, ${tok(entry.totals.totalTokens)} tokens, `
      + `${(entry.totals.cacheHitRate * 100).toFixed(1)}% cached, `
      + (entry.priced ? usd(entry.totals.costUSD) : 'not billed on the DeepSeek key'),
    )
  }
  for (const entry of (value?.days ?? []).slice(0, 14)) {
    lines.push(`  - ${entry.day}: ${usd(entry.totals.costUSD)}, ${entry.totals.calls} calls, ${tok(entry.totals.totalTokens)} tokens`)
  }
  if (value?.unpriced?.calls > 0) {
    lines.push(`${value.unpriced.calls} call(s) on other providers are excluded from the budget.`)
  }
  for (const source of value?.sources ?? []) {
    lines.push(
      `  source ${source.label}: ${source.calls} DeepSeek call(s)`
      + (source.detail ? ` (${source.detail})` : '')
      + (source.missing ? ' — unavailable' : ''),
    )
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * Raw JSON Schema for the Tool result.
 *
 * The registry enforces this schema, so every object node states its openness
 * explicitly and a nullable number is a two-branch `oneOf` (`type` holds one
 * type name).
 */
const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    budgetUSD: { type: 'number' },
    window: {
      type: 'object',
      additionalProperties: true,
      properties: {
        name: { type: 'string' },
        from: { type: 'number' },
        to: { type: 'number' },
      },
    },
    totals: { type: 'object', additionalProperties: true },
    unpriced: {
      type: 'object',
      additionalProperties: true,
      properties: {
        calls: { type: 'number' },
        totalTokens: { type: 'number' },
      },
    },
    budget: {
      type: 'object',
      additionalProperties: true,
      properties: {
        spentUSD: { type: 'number' },
        remainingUSD: { type: 'number' },
        usedFraction: { type: 'number' },
        overBudget: { type: 'boolean' },
      },
    },
    headline: {
      type: 'object',
      additionalProperties: true,
      properties: {
        avgCostPerCallUSD: { type: 'number' },
        avgBillableTokensPerCall: { type: 'number' },
        avgTokensPerCall: { type: 'number' },
        callsRemainingInBudget: { oneOf: [{ type: 'number' }, { type: 'null' }] },
      },
    },
    models: { type: 'array' },
    days: { type: 'array' },
    sources: { type: 'array' },
    recordedCostUSD: { type: 'number' },
  },
}

/**
 * Directories to search for harness logs.
 *
 * Defaults to the current user's home. Overridable so a log store living
 * elsewhere is still found:
 *   DEEPSEEK_BUDGET_ROOTS  colon- or comma-separated list of directories
 *   DEEPSEEK_BUDGET_HOME   a single directory
 */
function searchRoots() {
  const configured = process.env.DEEPSEEK_BUDGET_ROOTS
  if (typeof configured === 'string' && configured.length > 0) {
    const roots = configured.split(/[:,]/).map((part) => part.trim()).filter(Boolean)
    if (roots.length > 0) return roots
  }
  const single = process.env.DEEPSEEK_BUDGET_HOME
  if (typeof single === 'string' && single.length > 0) return [single]
  return [process.env.HOME ?? process.env.USERPROFILE ?? '']
}

/** True when a file name may hold stored JSON records. */
function isJsonLogName(name) {
  return name.endsWith('.jsonl') || name.endsWith('.ndjson')
    || name.endsWith('.json') || name.endsWith('.log')
}

/**
 * Find every record log on this machine that carries DeepSeek usage.
 *
 * Discovery is by CONTENT, not by a list of known tools: any file holding a
 * `deepseek` model id is scanned, and the generic parser keeps only records that
 * also carry token usage on a DeepSeek route. A harness nobody has heard of is
 * therefore counted, and a log that merely mentions DeepSeek in prose is not.
 *
 * Only a cheap byte scan happens per file; the expensive parse is cached by
 * size+mtime, so a report re-reads only files that actually changed.
 */
async function discoverJsonLogs(roots, options = {}) {
  const maxDepth = options.maxDepth ?? 6
  const maxFileBytes = options.maxFileBytes ?? 20 * 1024 * 1024
  const skipDirs = options.skipDirs ?? [
    'node_modules', '.git', '.Trash', '.npm', '.cache', '.rustup', '.cargo',
    '.gradle', '.docker', 'Caches', '__pycache__', 'venv', 'dist', 'build',
  ]
  const skipPathParts = options.skipPathParts ?? ['/Library/Caches/', '/Library/Logs/', '/.venv/']
  const memo = options.memo

  const files = []
  const walk = async (dir, depth) => {
    if (depth > maxDepth) return
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (skipDirs.includes(entry.name)) continue
        await walk(child, depth + 1)
        continue
      }
      if (!entry.isFile() || !isJsonLogName(entry.name)) continue
      if (skipPathParts.some((part) => child.includes(part))) continue
      let signature = null
      try {
        const info = await stat(child)
        if (info.size === 0 || info.size > maxFileBytes) continue
        signature = `${info.size}:${info.mtimeMs}`
      } catch {
        continue
      }
      const remembered = memo?.get(child)
      if (remembered !== undefined && remembered.signature === signature) {
        if (remembered.hasDeepSeek) files.push(child)
        continue
      }
      let hasDeepSeek = false
      try {
        const bytes = await readFile(child)
        hasDeepSeek = bytes.toString('latin1').toLowerCase().includes('deepseek')
      } catch {
        continue
      }
      memo?.set(child, { signature, hasDeepSeek })
      if (hasDeepSeek) files.push(child)
    }
  }

  for (const root of roots) {
    if (typeof root === 'string' && root.length > 0) await walk(root, 1)
  }
  return files
}

/**
 * Session logs of every local coding harness that records DeepSeek usage.
 *
 * DSH keeps its own adapter because its log is compressed and carries stream
 * timing. Everything else goes through content discovery plus the generic
 * record parser, so a new harness is picked up without naming it. Only DeepSeek
 * routes are counted out of either.
 */
function createSources(ctx, memo = new Map()) {
  const roots = searchRoots()
  const home = roots[0] ?? ''
  const dshCache = new Map()
  const logCache = new Map()

  return [
    {
      id: 'dsh',
      label: 'DSH session logs',
      detail: 'session logs written by this harness',
      async read() {
        const calls = []
        const persistence = ctx.get('sessionPersistence')
        if (persistence === undefined) {
          return { calls, detail: 'this harness is not present', missing: true }
        }
        let snapshots = []
        try {
          snapshots = await persistence.list()
        } catch (error) {
          console.error(`[${PLUGIN_NAME}] cannot list DSH sessions:`, String(error?.message ?? error))
          return { calls, detail: 'session store unavailable' }
        }
        for (const snapshot of snapshots) {
          const id = snapshot.header.id
          const revision = String(snapshot.revision)
          const cached = dshCache.get(id)
          if (cached !== undefined && cached.revision === revision) {
            calls.push(...cached.calls)
            continue
          }
          let events = null
          try {
            const handle = await persistence.open(id, 'read')
            try {
              events = (await handle.read()).events
            } finally {
              await handle.close()
            }
          } catch (error) {
            console.error(`[${PLUGIN_NAME}] cannot read DSH session ${id}:`, String(error?.message ?? error))
          }
          const sessionCalls = events === null ? [] : extractCalls(events)
          dshCache.set(id, { revision, calls: sessionCalls })
          calls.push(...sessionCalls)
        }
        return { calls, detail: `${snapshots.length} session log(s)` }
      },
    },
    {
      id: 'logs',
      label: 'Other harness logs',
      detail: 'discovered by content',
      async read() {
        const calls = []
        const files = await discoverJsonLogs(roots, { memo })
        if (files.length === 0) {
          return { calls, detail: 'no DeepSeek-bearing log found', missing: true }
        }
        let scanned = 0
        for (const file of files) {
          let signature = null
          try {
            const info = await stat(file)
            signature = `${info.size}:${info.mtimeMs}`
          } catch {
            continue
          }
          const cached = logCache.get(file)
          if (cached !== undefined && cached.signature === signature) {
            calls.push(...cached.calls)
            scanned += 1
            continue
          }
          let text = null
          try {
            text = await readFile(file, 'utf8')
          } catch {
            continue
          }
          const fileCalls = parseJsonRecords(text)
          logCache.set(file, { signature, calls: fileCalls })
          calls.push(...fileCalls)
          scanned += 1
        }
        return { calls, detail: `${scanned} log(s) with DeepSeek usage` }
      },
    },
  ]
}

/**
 * Drop calls that two logs both recorded.
 *
 * A harness may write the same call into a parent session and into the
 * transcript of the subagent that made it. Deduplication is global, not
 * per-file, because those copies live in different files.
 *
 * The provider's own response id is authoritative when present. Otherwise a
 * fingerprint of time, route and token counts stands in — it is deliberately
 * strict, so two genuinely distinct calls are never merged.
 */
function dedupeCalls(calls) {
  const seen = new Set()
  const unique = []
  for (const call of calls) {
    const key = typeof call.dedupKey === 'string' && call.dedupKey.length > 0
      ? `${call.canonicalProvider}/${call.canonicalModel}#${call.dedupKey}`
      : `fp:${call.time}|${call.canonicalProvider}/${call.canonicalModel}`
        + `|${call.uncachedInput}|${call.cacheRead}|${call.output}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(call)
  }
  return unique
}

/** Read every source once and report what each contributed. */
/** Read one credential, falling back to the environment. */
async function resolveSecret(ctx, ref) {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(ref)
      if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value.length > 0) {
        return resolved.value
      }
    } catch {
      // Fall through to the environment.
    }
  }
  const fromEnv = process.env[ref]
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : null
}

async function fetchJson(url, headers) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', ...headers },
    redirect: 'manual',
    signal: AbortSignal.timeout(ACCOUNT_TIMEOUT_MS),
  })
  const text = await response.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    data = null
  }
  return { status: response.status, data }
}

function toNumber(value) {
  const parsed = typeof value === 'number' ? value : parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Account balance for the shared key.
 *
 * Returns every currency the account holds, so a EUR-budgeted company can see
 * which line is theirs instead of one number being silently converted.
 */
async function fetchAccountBalance(ctx) {
  const apiKey = await resolveSecret(ctx, API_KEY_REF)
  if (apiKey === null) return { available: false, reason: 'no_api_key' }
  try {
    const { status, data } = await fetchJson(BALANCE_URL, { authorization: `Bearer ${apiKey}` })
    if (status === 401 || status === 403) return { available: false, reason: 'key_rejected' }
    if (status !== 200 || data === null || !Array.isArray(data.balance_infos)) {
      return { available: false, reason: `http_${status}` }
    }
    return {
      available: true,
      isAvailable: data.is_available === true,
      currencies: data.balance_infos.map((info) => ({
        currency: String(info.currency ?? ''),
        total: toNumber(info.total_balance),
        granted: toNumber(info.granted_balance),
        toppedUp: toNumber(info.topped_up_balance),
      })),
    }
  } catch (error) {
    return { available: false, reason: error?.name === 'TimeoutError' ? 'timeout' : 'network_error' }
  }
}

/** Sum every non-request usage amount in a platform cost payload. */
function sumCostPayload(data) {
  const biz = data?.data?.biz_data
  const item = (Array.isArray(biz) ? biz[0] : biz) ?? {}
  let total = 0
  for (const model of item.total ?? []) {
    for (const usage of model.usage ?? []) {
      if ((usage.type ?? '') !== 'REQUEST') total += toNumber(usage.amount)
    }
  }
  return total
}

/** Total tokens (cache hit + miss + output) in a platform amount payload. */
function sumAmountPayload(data) {
  const biz = data?.data?.biz_data
  const item = (Array.isArray(biz) ? biz[0] : biz) ?? {}
  let tokens = 0
  for (const model of item.total ?? []) {
    for (const usage of model.usage ?? []) {
      const type = usage.type ?? ''
      if (type !== 'REQUEST') tokens += toNumber(usage.amount)
    }
  }
  return tokens
}

/**
 * Whole-account usage for one month, from the platform API.
 *
 * This is key-wide: it counts every developer and every API key on the account,
 * so it is the only figure that answers "how much of the company budget is gone".
 * It needs a platform user token — the API key is not accepted here.
 */
async function fetchAccountUsage(ctx, month, year) {
  const token = await resolveSecret(ctx, USER_TOKEN_REF)
  if (token === null) return { available: false, reason: 'no_user_token' }
  const headers = {
    authorization: `Bearer ${token}`,
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    referer: 'https://platform.deepseek.com/usage',
  }
  const query = `?month=${month}&year=${year}`
  try {
    const [cost, amount] = await Promise.all([
      fetchJson(USAGE_COST_URL + query, headers),
      fetchJson(USAGE_AMOUNT_URL + query, headers),
    ])
    if (cost.status === 401 || cost.status === 403 || amount.status === 401 || amount.status === 403) {
      return { available: false, reason: 'token_rejected' }
    }
    if (cost.status !== 200 || amount.status !== 200 || cost.data === null) {
      return { available: false, reason: `http_${cost.status}` }
    }
    const biz = cost.data?.data?.biz_data
    const item = (Array.isArray(biz) ? biz[0] : biz) ?? {}
    const currency = String(item.currency ?? 'CNY')
    const perModel = []
    for (const model of item.total ?? []) {
      let modelCost = 0
      for (const usage of model.usage ?? []) {
        if ((usage.type ?? '') !== 'REQUEST') modelCost += toNumber(usage.amount)
      }
      if (model.name ?? model.model) perModel.push({ model: String(model.name ?? model.model), cost: modelCost })
    }
    perModel.sort((left, right) => right.cost - left.cost)
    return {
      available: true,
      currency,
      month,
      year,
      cost: sumCostPayload(cost.data),
      tokens: sumAmountPayload(amount.data),
      models: perModel,
    }
  } catch (error) {
    return { available: false, reason: error?.name === 'TimeoutError' ? 'timeout' : 'network_error' }
  }
}

/** Everything the panel shows about the company account, with a short TTL cache. */
function createAccountReader(ctx) {
  let cache = null
  const TTL_MS = 60_000
  return async function accountReport() {
    const now = Date.now()
    if (cache !== null && now - cache.at < TTL_MS) return cache.value

    const today = new Date()
    const [balance, usage] = await Promise.all([
      fetchAccountBalance(ctx),
      fetchAccountUsage(ctx, today.getMonth() + 1, today.getFullYear()),
    ])

    // Prefer whichever currency the account actually reports for spend.
    const currency = usage.available ? usage.currency : (balance.available ? balance.currencies[0]?.currency ?? null : null)
    const spent = usage.available ? usage.cost : null
    const budgeted = budgetInCurrency(currency, currencyRates())

    const value = {
      budgetEUR: BUDGET_EUR,
      currency,
      balance,
      usage,
      company: {
        spentThisMonth: spent,
        // A EUR budget only compares directly with EUR, or with USD through the
        // configured rate. Any other currency is reported without a fraction.
        budgetInCurrency: budgeted,
        usedFraction: budgeted !== null && spent !== null && budgeted > 0 ? spent / budgeted : null,
        remainingInCurrency: budgeted !== null && spent !== null ? budgeted - spent : null,
      },
      fetchedAt: now,
    }
    cache = { at: now, value }
    return value
  }
}

function createCollector(ctx) {
  const sources = createSources(ctx)

  async function collectCalls() {
    const calls = []
    const report = []
    for (const source of sources) {
      try {
        const result = await source.read()
        calls.push(...result.calls)
        report.push({
          id: source.id,
          label: source.label,
          detail: result.detail ?? '',
          calls: result.calls.length,
          missing: result.missing === true,
        })
      } catch (error) {
        console.error(`[${PLUGIN_NAME}] source ${source.id} failed:`, String(error?.message ?? error))
        report.push({ id: source.id, label: source.label, detail: 'read failed', calls: 0, missing: true })
      }
    }
    return { calls: dedupeCalls(calls), sources: report }
  }

  return async function usageReport(args) {
    const requested = typeof args?.window === 'string' ? args.window : 'all'
    const now = Date.now()
    const collected = await collectCalls()
    return buildReport(collected.calls, {
      ...resolveWindow(requested, now),
      name: requested,
      sources: collected.sources,
    }, now)
  }
}

/** Reject anything that is not a loopback request; blocks DNS-rebinding reads. */
function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress ?? ''
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  if (!loopback) return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

export function apply(ctx) {
  const usageReport = createCollector(ctx)
  const accountReport = createAccountReader(ctx)

  // The account-wide view: balance for the shared key, plus whole-account spend
  // when a platform user token is configured. Read-only, so no origin guard.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ACCOUNT_ROUTE,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      try {
        sendJson(res, 200, await accountReport())
      } catch (error) {
        console.error(`[${PLUGIN_NAME}] account failed:`, String(error?.message ?? error))
        sendJson(res, 500, { error: 'account lookup failed' })
      }
    },
  }), `${PLUGIN_NAME}: account route`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      const requested = new URL(req.url ?? ROUTE_PATH, 'http://127.0.0.1').searchParams.get('window') ?? 'all'
      try {
        sendJson(res, 200, await usageReport({ window: requested }))
      } catch (error) {
        console.error(`[${PLUGIN_NAME}] report failed:`, String(error?.message ?? error))
        sendJson(res, 500, { error: 'report failed' })
      }
    },
  }), `${PLUGIN_NAME}: report route`)

  ctx.effect(() => ctx.tools.register({
    name: TOOL_NAME,
    description:
      'Report measured DeepSeek API spend against the $10 budget: tokens, cost by model, '
      + 'cache-hit rate, and speed (time to first token, output tokens per second). '
      + 'Reads real provider-reported usage from local DSH session logs.',
    parameters: {
      type: 'object',
      properties: {
        window: {
          type: 'string',
          enum: ['today', '7d', '30d', 'all'],
          description: 'Time window to measure. Defaults to all recorded history.',
        },
      },
    },
    output: { schema: REPORT_SCHEMA, render: (_args, value) => renderReport(value) },
    execute: async (args) => usageReport(args),
  }), `${PLUGIN_NAME}: usage tool`)
}

// Pure helpers, exported so `test/logic.test.mjs` can check the pricing without
// a running harness. The Loader only needs `name`, `inject` and `apply`.
export { priceCall, canonicalRoute, budgetInCurrency, currencyRates, resolveWindow, streamTiming, extractCalls, parsePiSession, parseJsonRecords, normalizeUsage, discoverJsonLogs, dedupeCalls, buildReport, createSources }
