// Self-check for the pricing, windowing and log-parsing logic in lib/index.js.
//
// The host half has no dependency outside Node, so the module imports directly
// and the pure logic is checked standalone: `node test/logic.test.mjs`.

import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as logic from '../lib/index.js'

let checked = 0

function assert(condition, message) {
  checked += 1
  if (!condition) {
    console.error(`FAIL: ${message}`)
    process.exit(1)
  }
}

const usage = { inputTokens: 2050, outputTokens: 334, cacheReadTokens: 2020736, reasoningTokens: 100 }
const offPeakCost = (2050 * 0.15 + 2020736 * 0.003 + 334 * 0.6) / 1e6

// --- peak/off-peak banding and rates -------------------------------------

const offPeak = logic.priceCall('deepseek-official', 'deepseek-flash', usage, Date.UTC(2026, 8, 25, 19, 0, 0))
assert(offPeak.band === 'offPeak', `weekday 19:00 UTC is off-peak, got ${offPeak.band}`)
assert(Math.abs(offPeak.cost - offPeakCost) < 1e-12, 'off-peak cost is miss/hit/output at off-peak rates')

const peak = logic.priceCall('deepseek-official', 'deepseek-flash', usage, Date.UTC(2026, 8, 22, 2, 0, 0))
assert(peak.band === 'peak', `Tuesday 02:00 UTC is peak, got ${peak.band}`)
assert(Math.abs(peak.cost - offPeakCost * 2) < 1e-12, 'peak is exactly twice off-peak')

assert(
  logic.priceCall('deepseek-official', 'deepseek-flash', usage, Date.UTC(2026, 8, 26, 2, 0, 0)).band === 'offPeak',
  'weekends are off-peak even inside peak hours',
)
assert(
  logic.priceCall('deepseek-official', 'deepseek-flash', usage, Date.UTC(2026, 9, 1, 2, 0, 0)).band === 'offPeak',
  'Chinese public holidays are off-peak in full',
)

// --- model routing --------------------------------------------------------

const legacy = logic.priceCall('deepseek-official', 'deepseek-v4-flash', usage, Date.UTC(2026, 8, 25, 19, 0, 0))
assert(legacy !== null && Math.abs(legacy.cost - offPeakCost) < 1e-12, 'retired ids are billed as Flash')
assert(logic.priceCall('ollama', 'qwen3.5:9b', usage, Date.now()) === null, 'other providers are unpriced')
assert(logic.priceCall('deepseek-official', 'unknown', usage, Date.now()) === null, 'unknown models are unpriced')

// --- windows --------------------------------------------------------------

const now = Date.UTC(2026, 8, 25, 12, 0, 0)
assert(logic.resolveWindow('all', now).from === 0, 'all-time starts at zero')
assert(logic.resolveWindow('today', now).from === Date.UTC(2026, 8, 25), 'today starts at UTC midnight')
assert(logic.resolveWindow('7d', now).from === now - 7 * 86400000, '7d spans seven days')

// --- stream timing --------------------------------------------------------

const timing = logic.streamTiming([
  { type: 'chunk', time: 1000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
  { type: 'reasoning-chunks', time0: 1200, index: 0, dt: [100, 200], texts: ['a', 'b', 'c'] },
])
assert(timing.start === 1000, 'start comes from the first timed record')
assert(timing.end === 1500, 'end is time0 plus the running delta sum')
assert(timing.firstText === 1200, 'first text is the first content record')
assert(logic.streamTiming([]) === null, 'no records yields no timing')

// --- call extraction ------------------------------------------------------

const events = [
  { type: 'step/start', seq: 1, time: 500, data: { turn: 1, step: 1 } },
  { type: 'request/context', seq: 2, time: 501, data: { provider: 'deepseek-official', model: 'deepseek-flash' } },
  {
    type: 'assistant/message',
    seq: 3,
    time: 2000,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', source: { provider: 'deepseek-official', model: 'deepseek-flash' } },
      usage: { inputTokens: 10, cacheReadTokens: 990, outputTokens: 50 },
      stream: [{ type: 'reasoning-chunks', time0: 1500, index: 0, dt: [100], texts: ['x'] }],
    },
  },
]
const calls = logic.extractCalls(events)
assert(calls.length === 1, 'one call per assistant message')
assert(calls[0].uncachedInput === 10 && calls[0].cacheRead === 990 && calls[0].output === 50, 'usage fields map through')
assert(calls[0].ttftMs === 1000, `ttft measured from step start, got ${calls[0].ttftMs}`)
assert(calls[0].durationMs === 1100, `duration measured from step start, got ${calls[0].durationMs}`)
assert(calls[0].priced === true, 'a DeepSeek call is priced')
assert(
  logic.extractCalls([{ type: 'assistant/message', seq: 1, time: 1, data: { turn: 1, step: 1 } }]).length === 0,
  'a message without usage is skipped, not counted as zero',
)

// --- aggregation ----------------------------------------------------------

const report = logic.buildReport(calls, { ...logic.resolveWindow('all', now), name: 'all' }, now)
assert(report.totals.calls === 1, 'report counts the call')
assert(Math.abs(report.totals.cacheHitRate - 0.99) < 1e-12, 'cache-hit rate is hits over all input')
// A cache hit is nearly free, so the billed average must exclude cache reads.
assert(report.headline.avgBillableTokensPerCall === 60, `billed average excludes cache reads, got ${report.headline.avgBillableTokensPerCall}`)
assert(report.headline.avgTokensPerCall === 1050, `total average includes cache reads, got ${report.headline.avgTokensPerCall}`)
assert(report.budgetUSD === 10, 'budget is stated')
assert(report.budget.overBudget === false, 'small spend is under budget')
assert(report.models.length === 1 && report.days.length === 1, 'grouped by model and day')

const mixed = logic.buildReport(
  logic.extractCalls([
    { type: 'step/start', seq: 1, time: 0, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      seq: 2,
      time: 100,
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', source: { provider: 'ollama', model: 'qwen3.5:9b' } },
        usage: { inputTokens: 500, outputTokens: 100 },
        stream: [],
      },
    },
  ]),
  { from: 0, to: Date.now(), name: 'all' },
  Date.now(),
)
assert(mixed.totals.calls === 0, 'unpriced calls stay out of the budget totals')
assert(mixed.unpriced.calls === 1, 'unpriced calls are still reported')
assert(mixed.budget.spentUSD === 0, 'unpriced calls cost nothing')

// --- multi-harness routing -------------------------------------------------

// DSH says `deepseek-official`, Pi says `deepseek`; both must reach one route.
assert(logic.canonicalRoute('deepseek-official', 'deepseek-flash').provider === 'deepseek-official', 'DSH route canonicalises')
assert(logic.canonicalRoute('deepseek', 'deepseek-v4-flash').model === 'deepseek-flash', 'Pi route canonicalises, retired id mapped')
assert(logic.canonicalRoute('claude-bridge', 'claude-opus-4-8') === undefined, 'Anthropic routes are excluded')
assert(logic.canonicalRoute('ollama', 'qwen3.5:9b') === undefined, 'local models are excluded')
assert(logic.canonicalRoute('openrouter', 'deepseek/deepseek-flash') !== undefined, 'a prefixed deepseek id is still recognised')

// A Pi session log, in Pi's own field names.
const piLog = [
  JSON.stringify({ type: 'session', id: 'x' }),
  JSON.stringify({
    type: 'message',
    timestamp: '2026-09-25T12:00:00.000Z',
    message: {
      role: 'assistant',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      usage: {
        input: 1000,
        output: 500,
        cacheRead: 4000,
        cacheWrite: 0,
        reasoning: 200,
        cost: { input: 0.00014, output: 0.00014, cacheRead: 0.0000112, total: 0.0002912 },
      },
    },
  }),
  JSON.stringify({
    type: 'message',
    timestamp: '2026-09-25T12:00:05.000Z',
    message: { role: 'assistant', provider: 'claude-bridge', model: 'claude-opus-4-8', usage: { input: 5, output: 50, cacheRead: 900 } },
  }),
  '{ this line is not json',
  JSON.stringify({ type: 'message', timestamp: '2026-09-25T12:00:06.000Z', message: { role: 'user', content: 'hi' } }),
].join('\n')

const piCalls = logic.parsePiSession(piLog)
assert(piCalls.length === 1, `only DeepSeek assistant turns become calls, got ${piCalls.length}`)
const piCall = piCalls[0]
assert(piCall.source === 'log', 'the call is tagged with its source')
assert(piCall.uncachedInput === 1000 && piCall.cacheRead === 4000 && piCall.output === 500, 'Pi usage fields are mapped')
assert(piCall.reasoningTokens === 200, 'Pi reasoning tokens are kept')
assert(piCall.canonicalModel === 'deepseek-flash', 'retired Pi id maps to Flash')
assert(piCall.time === Date.parse('2026-09-25T12:00:00.000Z'), 'Pi ISO timestamp becomes epoch ms')
assert(piCall.recordedCost === 0.0002912, "Pi's own recorded cost is preserved as a cross-check")
// 1000 miss + 4000 cache-hit + 500 output, off-peak.
const expectedPi = (1000 * 0.15 + 4000 * 0.003 + 500 * 0.6) / 1e6
assert(Math.abs(piCall.cost - expectedPi) < 1e-15, 'Pi calls are priced at published rates, not Pi rates')
assert(piCall.cost > piCall.recordedCost, 'published pricing is higher than Pi recorded pricing, as expected')
// Guard against a silently zeroed cost: the bug this catches returned priced=true with cost 0.
assert(piCall.cost > 0, `a priced call must have a non-zero cost, got ${piCall.cost}`)
assert(piCall.cost === expectedPi, 'the cost equals the published-rate computation exactly')

// Malformed and non-assistant records are skipped without throwing.
assert(logic.parsePiSession('').length === 0, 'empty input yields no calls')
assert(logic.parsePiSession('not json at all').length === 0, 'garbage yields no calls')

// Both harnesses land in one report, grouped under one canonical model.
const combined = logic.buildReport([...calls, ...piCalls], { from: 0, to: Date.now(), name: 'all', sources: [] }, Date.now())
assert(combined.totals.calls === 2, `calls from both harnesses are counted, got ${combined.totals.calls}`)
assert(combined.models.length === 1, 'both harnesses group under one canonical model')
assert(combined.models[0].model === 'deepseek-flash', 'the canonical model name is reported')
assert(Math.abs(combined.recordedCostUSD - 0.0002912) < 1e-15, 'recorded cost is surfaced for cross-checking')


// --- cross-log duplication -------------------------------------------------

const dupLog = JSON.stringify({
  type: 'message',
  timestamp: '2026-09-25T12:00:00.000Z',
  message: {
    role: 'assistant', provider: 'deepseek', model: 'deepseek-v4-flash',
    responseId: 'resp-1',
    usage: { input: 10, output: 20, cacheRead: 30 },
  },
})
const otherLog = JSON.stringify({
  type: 'message',
  timestamp: '2026-09-25T12:00:00.000Z',
  message: {
    role: 'assistant', provider: 'deepseek', model: 'deepseek-v4-flash',
    responseId: 'resp-1',
    usage: { input: 10, output: 20, cacheRead: 30 },
  },
})
const copyA = logic.parsePiSession(dupLog)[0]
const copyB = logic.parsePiSession(otherLog)[0]
assert(copyA !== undefined && copyB !== undefined, 'both copies parse')
assert(copyA.dedupKey === 'resp-1', 'the provider response id is kept for dedup')
assert(logic.dedupeCalls([copyA, copyB]).length === 1, 'the same call recorded twice counts once')

// Two genuinely different calls must never be merged.
const distinct = logic.parsePiSession(JSON.stringify({
  type: 'message',
  timestamp: '2026-09-25T12:00:00.000Z',
  message: {
    role: 'assistant', provider: 'deepseek', model: 'deepseek-v4-flash',
    responseId: 'resp-2',
    usage: { input: 10, output: 21, cacheRead: 30 },
  },
}))[0]
assert(logic.dedupeCalls([copyA, distinct]).length === 2, 'different calls are kept')

// Without a response id, a strict fingerprint still dedupes identical copies.
const noId = { time: 1, canonicalProvider: 'deepseek-official', canonicalModel: 'deepseek-flash', uncachedInput: 5, cacheRead: 6, output: 7, dedupKey: null }
assert(logic.dedupeCalls([noId, { ...noId }]).length === 1, 'identical fingerprint dedupes')
assert(logic.dedupeCalls([noId, { ...noId, output: 8 }]).length === 2, 'differing token counts stay distinct')


// --- portability: a harness that does not exist today ----------------------
//
// The point of content discovery is that no harness is named anywhere. These
// cases use shapes and paths that no tool on this machine produces, to prove a
// tool written tomorrow is still read.

// 1. A flat record (no `message` wrapper), snake_case tokens, a new provider
//    spelling, and a microsecond timestamp.
const flatFuture = JSON.stringify({
  provider: 'acme-gateway',
  model: 'accounts/acme/models/deepseek-v4-pro-0813',
  prompt_tokens: 2000,
  completion_tokens: 800,
  prompt_tokens_details: { cached_tokens: 1500 },
  created_at: 1790337600000000,
  responseId: 'acme-1',
})
const flatCalls = logic.parseJsonRecords(flatFuture)
assert(flatCalls.length === 1, `a flat record from an unknown harness is read, got ${flatCalls.length}`)
assert(flatCalls[0].canonicalModel === 'deepseek-v4-pro', 'a namespaced model id canonicalises')
assert(flatCalls[0].cacheRead === 1500, 'cached_tokens is understood')
assert(flatCalls[0].uncachedInput === 500, 'cached tokens are subtracted from a wire prompt total')
assert(flatCalls[0].time === 1790337600000, 'a microsecond timestamp is normalised to ms')

// 2. Wrapped under a key no harness here uses, with a nested usage envelope.
const wrappedFuture = JSON.stringify({
  envelope: 1,
  response: {
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    timestamp: '2026-09-25T12:00:00.000Z',
    usage: { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30 } },
  },
})
const wrappedCalls = logic.parseJsonRecords(wrappedFuture)
assert(wrappedCalls.length === 1, `a turn wrapped in a new key is still read, got ${wrappedCalls.length}`)
assert(wrappedCalls[0].uncachedInput === 10 && wrappedCalls[0].cacheRead === 30, 'a nested usage envelope is unwrapped')

// 3. A single JSON document holding an array of turns.
const arrayDoc = JSON.stringify({
  turns: [
    { provider: 'deepseek', model: 'deepseek-flash', input: 5, output: 6, cacheRead: 7, timestamp: '2026-09-25T12:00:00.000Z' },
    { provider: 'deepseek', model: 'deepseek-flash', input: 8, output: 9, cacheRead: 10, timestamp: '2026-09-25T12:00:01.000Z' },
  ],
})
const docCalls = logic.parseJsonRecords(arrayDoc)
assert(docCalls.length === 2, `a single-document log is read, got ${docCalls.length}`)

// 4. A nested record under `data`, which no tool here writes.
const nestedData = JSON.stringify({
  ts: 1790337600000,
  data: { provider: 'deepseek', model: 'deepseek-flash', usage: { input: 3, output: 4, cacheRead: 5 } },
})
assert(logic.parseJsonRecords(nestedData).length === 1, 'a turn nested under `data` is read')

// 5. Non-DeepSeek routes from that same unknown harness stay out.
const otherVendor = JSON.stringify({
  provider: 'acme-gateway',
  model: 'anthropic/claude-opus-5',
  input: 100,
  output: 100,
  timestamp: '2026-09-25T12:00:00.000Z',
})
assert(logic.parseJsonRecords(otherVendor).length === 0, 'a non-DeepSeek route from a new harness is excluded')

// 6. Discovery finds an unknown harness by content, in an unusual location.
const sandbox = await mkdtemp(join(tmpdir(), 'dsh-budget-discovery-'))
const oddDir = join(sandbox, 'opt', 'weird-tool', 'state', 'runs', '2026')
await mkdir(oddDir, { recursive: true })
await writeFile(join(oddDir, 'turn-log.ndjson'), flatFuture + '\n')
await writeFile(join(oddDir, 'unrelated.json'), JSON.stringify({ note: 'no vendor here' }))
const found = await logic.discoverJsonLogs([sandbox], { memo: new Map() })
assert(found.length === 1, `only the DeepSeek-bearing file is discovered, got ${found.length}`)
assert(found[0].endsWith('turn-log.ndjson'), 'a .ndjson log is discovered')

// 7. End to end: discovered file -> parsed -> priced.
const discoveredText = await readFile(found[0], 'utf8')
const discoveredCalls = logic.parseJsonRecords(discoveredText)
assert(discoveredCalls.length === 1, 'the discovered file yields its call')
assert(discoveredCalls[0].priced === true, 'the discovered call is priced')
assert(discoveredCalls[0].cost > 0, 'the discovered call has a non-zero cost')


// --- company account budget conversion -------------------------------------

// A EUR budget compares directly with a EUR bill.
assert(logic.budgetInCurrency('EUR', { EUR: 1 }) === 50, 'EUR budget compares directly')
// A USD report needs the configured rate: 50 EUR at 1.08 USD/EUR is 54 USD.
assert(logic.budgetInCurrency('USD', { USD: 1.08 }) === 54, 'USD budget uses USD per EUR')
// CNY likewise, so a CNY-billed account can still show progress.
assert(logic.budgetInCurrency('CNY', { CNY: 7.8 }) === 390, 'CNY budget uses CNY per EUR')
// An unknown currency yields no comparison rather than a wrong one.
assert(logic.budgetInCurrency('JPY', { EUR: 1 }) === null, 'an unrated currency has no comparison')
assert(logic.budgetInCurrency('', { EUR: 1 }) === null, 'a missing currency has no comparison')
assert(logic.budgetInCurrency('EUR', { EUR: 0 }) === null, 'a non-positive rate has no comparison')

// The shipped rate table must cover what an account can report here.
const rates = logic.currencyRates()
assert(rates.EUR === 1, 'EUR is always 1')
assert(rates.USD > 0 && rates.CNY > 0, 'USD and CNY rates are present and positive')

console.log(`logic self-check passed (${checked} assertions)`)
