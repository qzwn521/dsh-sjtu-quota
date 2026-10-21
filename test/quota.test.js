import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { QuotaController, usageCounts, lexicalInputEstimate, rateLimitWaitMs,
  isTransientRateLimit, cancellableSleep, RequestTooLargeError, MINUTE, configWithDefaults, resolveProviders } from '../src/quota.js'
import { openStateStore } from '../src/state.js'
import { installHooks } from '../src/plugin.js'

const options = (provider = 'sjtu') => ({ provider, model: 'test', maxTokens: 1,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })
function fakeController(config = {}) {
  let clock = Date.UTC(2026, 9, 14)
  const waits = []
  const controller = new QuotaController({ config: { providers: ['sjtu', 'sjtu-qwen38'], safetyRatio: 1, ...config }, now: () => clock,
    sleep: async (ms, signal) => { signal?.throwIfAborted(); waits.push(ms); clock += ms },
    onWait: wait => waits.push(wait.reason) })
  return { controller, waits, now: () => clock, advance: ms => { clock += ms } }
}
function fakeContext() {
  const hooks = new Map()
  let command
  return { hooks, command: () => command,
    get: name => name === 'commands' ? { register(def) { command = def; return () => {} } } : undefined,
    on(name, handler) { hooks.set(name, handler); return () => hooks.delete(name) } }
}

test('DSH cache buckets are added once; reasoning is not double counted', () => {
  assert.deepEqual(usageCounts({ inputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 20,
    outputTokens: 30, reasoningTokens: 15, totalTokens: 150 }),
  { input: 120, output: 30, cacheRead: 90, cacheWrite: 20, reasoning: 15, total: 150 })
  assert.equal(usageCounts({ inputTokens: -1, outputTokens: 5 }), null)
  assert.equal(usageCounts({ inputTokens: 10, outputTokens: 20, totalTokens: 3 }).total, 30)
})

test('Chinese and tool results are estimated instead of character/4 undercounting', () => {
  const a = lexicalInputEstimate({ messages: [{ content: [{ type: 'text', text: '中'.repeat(100) }] }] })
  const b = lexicalInputEstimate({ messages: [{ content: [{ type: 'tool-result', content: [{ type: 'text', text: '中'.repeat(100) }] }] }] })
  assert.ok(a >= 150)
  assert.ok(b >= a)
})

test('minute token pressure waits for the recorded window, then continues', async () => {
  const { controller, waits, now } = fakeController({ tokensPerMinute: 200 })
  const first = await controller.acquire(options())
  controller.settle(first, { inputTokens: 100, outputTokens: 80 })
  const start = now()
  const second = await controller.acquire(options())
  assert.ok(now() - start >= MINUTE)
  assert.ok(waits.includes('每分钟 Token 余量不足'))
  controller.settle(second, { inputTokens: 1, outputTokens: 1 })
})

test('eleventh request waits even when token capacity remains', async () => {
  const { controller, waits, now } = fakeController()
  const start = now()
  for (let i = 0; i < 11; i++) {
    const permit = await controller.acquire(options())
    controller.settle(permit, { inputTokens: 1, outputTokens: 1 })
  }
  assert.ok(now() - start >= MINUTE)
  assert.ok(waits.includes('每分钟请求次数不足'))
})

test('different SJTU routes share the same token and RPM ledger', async () => {
  const { controller, now } = fakeController({ requestsPerMinute: 1 })
  const a = await controller.acquire(options('sjtu'))
  controller.settle(a, { inputTokens: 1, outputTokens: 1 })
  const start = now()
  const b = await controller.acquire(options('sjtu-qwen38'))
  assert.ok(now() - start >= MINUTE)
  controller.settle(b, { inputTokens: 1, outputTokens: 1 })
  assert.equal(controller.matches('zhipu-vision'), false)
})

test('a request larger than one minute never enters an infinite wait', async () => {
  const { controller, waits } = fakeController({ tokensPerMinute: 10 })
  await assert.rejects(controller.acquire(options()), RequestTooLargeError)
  assert.equal(waits.length, 0)
  assert.equal(controller.queue.length, 0)
})

test('Retry-After wins; reasonable UTC reset is parsed; clock skew falls back', () => {
  const now = Date.UTC(2026, 9, 14, 5, 0, 0)
  assert.equal(rateLimitWaitMs({ providerRetryAfterMs: 75_000 }, now), 76_000)
  assert.equal(rateLimitWaitMs({ message: 'Limit resets at: 2026-10-14 05:00:40 UTC' }, now), 41_000)
  assert.equal(rateLimitWaitMs({ message: 'Limit resets at: 2026-10-14 13:00:40 UTC' }, now), 61_000)
  assert.equal(rateLimitWaitMs({}, now), 61_000)
})

test('quota exhaustion and authentication are not endlessly retried', () => {
  assert.ok(isTransientRateLimit({ code: 'RATE_LIMIT', message: 'Limit type: tokens. Current limit: 300000' }))
  assert.equal(isTransientRateLimit({ code: 'RATE_LIMIT', message: 'insufficient_quota' }), false)
  assert.equal(isTransientRateLimit({ status: 429, message: 'weekly budget exceeded' }), false)
  assert.equal(isTransientRateLimit({ code: 'AUTH', status: 401 }), false)
  assert.equal(isTransientRateLimit({ code: 'QUOTA', status: 429 }), false)
  assert.equal(isTransientRateLimit({ code: 'ACCOUNT_QUOTA', status: 429 }), false)
  assert.equal(isTransientRateLimit({ code: 'RATE_LIMIT', message: 'Limit type: tokens. Current limit: 1000000000' }), false)
})

test('abort immediately removes a queued waiter and does not send a request', async () => {
  const controller = new QuotaController({ config: { maxConcurrent: 1 } })
  const first = await controller.acquire(options())
  const abort = new AbortController()
  const queued = controller.acquire(options(), abort.signal)
  abort.abort(new Error('user stopped'))
  await assert.rejects(queued, /user stopped/)
  assert.equal(controller.queue.length, 0)
  assert.equal(controller.waiters.size, 0)
  controller.settle(first, { inputTokens: 1, outputTokens: 1 })
})

test('relative cooldown and cancelled sleep remain cancellable', async () => {
  const abort = new AbortController()
  const sleep = cancellableSleep(60_000, abort.signal)
  abort.abort(new Error('stop'))
  await assert.rejects(sleep, /stop/)
})

test('last stream usage replaces earlier provisional samples', async () => {
  const { controller } = fakeController()
  const ctx = fakeContext()
  const dispose = installHooks(ctx, controller)
  let dispatched = 0
  const expected = [
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } },
    { type: 'usage', usage: { inputTokens: 30, outputTokens: 10 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const stream = ctx.hooks.get('llm/stream')(options(), () => {
    dispatched++
    return (async function* () { yield* expected })()
  })
  const observed = []
  for await (const chunk of stream) observed.push(chunk)
  assert.deepEqual(observed, expected)
  assert.equal(dispatched, 1)
  assert.equal(controller.records[0].tokens, 40)
  assert.equal(controller.stats.completed, 1)
  await dispose()
})

test('429 is recovered past five attempts using native retry events, not replaying tools', async () => {
  const { controller } = fakeController()
  const ctx = fakeContext()
  const dispose = installHooks(ctx, controller)
  const events = []
  const agent = { session: { append(type, data) { events.push({ type, data }) } } }
  for (let i = 0; i < 7; i++) {
    const stream = ctx.hooks.get('llm/stream')(options(), () => (async function* () {
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', status: 429,
        message: 'Rate limit exceeded for api_key: secret-that-must-not-be-copied' } } }
    })())
    for await (const _ of stream) {}
    const decision = await ctx.hooks.get('agent/request-error')({ agent, turn: 1, step: 2,
      provider: 'sjtu', failure: { code: 'RATE_LIMIT' }, signal: new AbortController().signal },
    () => { throw new Error('Built-in five-attempt policy must not take over') })
    assert.deepEqual(decision, { kind: 'retry' })
  }
  assert.equal(controller.stats.retries, 7)
  assert.equal(events.filter(e => e.type === 'llm/retry').length, 7)
  assert.equal(events.at(-2).data.retry, 7)
  assert.ok(!JSON.stringify(events).includes('secret-that-must-not-be-copied'))
  assert.equal(controller.snapshot().weeklyLocalTokens, 0)
  await dispose()
})

test('an unknown provider is passed through untouched', async () => {
  const { controller } = fakeController()
  const ctx = fakeContext()
  const dispose = installHooks(ctx, controller)
  const sentinel = (async function* () {})()
  assert.equal(ctx.hooks.get('llm/stream')(options('other'), () => sentinel), sentinel)
  assert.equal(ctx.hooks.get('agent/request-error')({ provider: 'other' }, () => 123), 123)
  await dispose()
})

test('state survives restart, including conservative abandoned reservations', () => {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-quota-test-'))
  const file = join(folder, 'ledger.json')
  try {
    const store = openStateStore(file)
    assert.throws(() => openStateStore(file), /另一 DSH 实例/)
    const controller = new QuotaController({ save: state => store.save(state) })
    controller.records.push({ id: 'abandoned', provider: 'sjtu', model: 'test',
      startedAt: Date.now(), settledAt: Date.now(), tokens: 200, pending: true, estimated: true })
    controller.persist()
    store.close()
    const reopened = openStateStore(file)
    const restored = new QuotaController({ state: reopened.state })
    assert.equal(restored.snapshot().tokensReservedOrUsed, 200)
    assert.equal(restored.snapshot().inFlight, 0)
    assert.ok(!readFileSync(file, 'utf8').includes('apiKey'))
    reopened.close()
  } finally {
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()))
    assert.ok(basename(folder).startsWith('dsh-quota-test-'))
    rmSync(folder, { recursive: true, force: true })
  }
})

test('statistics command exposes local scope instead of pretending to query account balance', async () => {
  const { controller } = fakeController()
  const ctx = fakeContext()
  const dispose = installHooks(ctx, controller)
  const result = await ctx.command().handler()
  assert.equal(result.kind, 'success')
  assert.match(result.text, /不代表学校账号真实周余额/)
  await dispose()
})

test('plugin unload cancels a preflight wait and drains it before returning', async () => {
  const controller = new QuotaController({ config: { providers: ['sjtu'] } })
  const first = await controller.acquire(options())
  const ctx = fakeContext()
  const dispose = installHooks(ctx, controller)
  let dispatched = false
  const iterator = ctx.hooks.get('llm/stream')(options(), () => {
    dispatched = true
    return (async function* () {})()
  })[Symbol.asyncIterator]()
  const waiting = iterator.next()
  const stopped = assert.rejects(waiting, /disposed/)
  await dispose()
  await stopped
  assert.equal(dispatched, false)
  assert.equal(controller.queue.length, 0)
  controller.settle(first, { inputTokens: 1, outputTokens: 1 })
})

test('public defaults detect custom SJTU route IDs without personal configuration', () => {
  const config = configWithDefaults()
  assert.deepEqual(config.providers, [])
  assert.deepEqual(resolveProviders(config, {
    'my-university': { baseURL: 'https://models.sjtu.edu.cn/api/v1' },
    'lookalike': { baseURL: 'https://models.sjtu.edu.cn.attacker.invalid/api/v1' },
    'other': { baseURL: 'https://other.invalid/v1' },
    'bad': { baseURL: 'not a url' },
  }), ['my-university'])
  assert.deepEqual(resolveProviders(configWithDefaults({ providers: ['manual'], autoDetect: true }), {}), ['manual'])
  assert.deepEqual(resolveProviders(configWithDefaults({ autoDetect: false }), {
    'my-university': { baseURL: 'https://models.sjtu.edu.cn/api/v1' },
  }), [])
})

test('retry chain is resumed from durable events after a plugin reload', async () => {
  const { controller } = fakeController()
  const ctx = fakeContext()
  const dispose = installHooks(ctx, controller)
  const history = [{ type: 'llm/retry', data: { turn: 1, step: 2, provider: 'sjtu',
    policyKey: 'dsh-sjtu-quota-v1', retry: 5, retryId: 'old-chain' } }]
  const agent = { session: { snapshotEvents: () => history, append(type, data) { history.push({ type, data }) } } }
  const result = await ctx.hooks.get('agent/request-error')({ agent, turn: 1, step: 2,
    provider: 'sjtu', failure: { code: 'RATE_LIMIT' }, signal: new AbortController().signal }, () => {})
  assert.deepEqual(result, { kind: 'retry' })
  assert.equal(history.at(-2).data.retry, 6)
  assert.equal(history.at(-2).data.retryId, 'old-chain')
  await dispose()
})

test('partial usage on a failed stream remains charged to the quota', async () => {
  const { controller } = fakeController()
  const ctx = fakeContext()
  const dispose = installHooks(ctx, controller)
  for await (const _ of ctx.hooks.get('llm/stream')(options(), () => (async function* () {
    yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 12 } }
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }
  })())) {}
  assert.equal(controller.snapshot().weeklyLocalTokens, 42)
  assert.equal(controller.records[0].estimated, false)
  await dispose()
})

test('long-running use compacts expired minute records without losing weekly totals', () => {
  const { controller, now, advance } = fakeController()
  for (let i = 0; i < 10000; i++) controller.records.push({ id: `old-${i}`, startedAt: now(),
    settledAt: now(), tokens: 100, pending: false, estimated: false })
  advance(61000)
  const snapshot = controller.snapshot()
  assert.equal(snapshot.weeklyLocalTokens, 1_000_000)
  assert.equal(snapshot.tokensReservedOrUsed, 0)
  assert.equal(controller.records.length, 0)
  assert.equal(controller.history.length, 1)
  const restored = new QuotaController({ now, state: controller.exportState() })
  assert.equal(restored.snapshot().weeklyLocalTokens, 1_000_000)
  advance(8 * 24 * 60 * MINUTE)
  assert.equal(controller.snapshot().weeklyLocalTokens, 0)
})
