import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { readFileSync, mkdirSync } from 'node:fs'
import { QuotaController } from '../src/quota.js'
import { installHooks } from '../src/plugin.js'

const host = process.argv[2]
if (!host) throw new Error('Usage: node scripts/verify-host.mjs <DSH resources/app>')
const hostRequire = createRequire(join(resolve(host), 'package.json'))
const plugin = await import(pathToFileURL(resolve(process.argv[3] ?? fileURLToPath(new URL('../src/index.js', import.meta.url)))))
const hostImport = id => import(pathToFileURL(hostRequire.resolve(id)))
const { Context } = await hostImport('@deepseek-ai/cordis')
const { LlmRuntime, LlmAdapter } = await hostImport('@deepseek-ai/dsh-llm')
const settingsModule = await hostImport('@deepseek-ai/dsh-settings')
const { default: CommandRuntime } = await hostImport('@deepseek-ai/dsh-commands')
const retryInvariant = await hostImport('@deepseek-ai/dsh-llm-retry/invariant')

const context = new Context()
let clock = Date.UTC(2026, 9, 14)
const controller = new QuotaController({ config: { providers: ['sjtu'] }, now: () => clock,
  sleep: async (ms, signal) => { signal?.throwIfAborted(); clock += ms } })
const hookCleanup = installHooks(context, controller)
const llm = new LlmRuntime(context)
let dispatches = 0
class TestAdapter extends LlmAdapter {
  modelInfo(provider, model) { return { provider, id: model, name: model, defaultMaxTokens: 16 } }
  async *stream() {
    dispatches++
    if (dispatches <= 6) {
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', status: 429,
        message: 'Limit type: tokens. Current limit: 300000', providerRetryAfterMs: 65_000 } } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'continued' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'continued' } }
      yield { type: 'usage', usage: { inputTokens: 100, cacheReadTokens: 200, outputTokens: 10, totalTokens: 310 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}
llm.registerAdapter(['sjtu'], new TestAdapter())
const events = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'step/start', data: { turn: 1, step: 1 } },
  { type: 'request/header', data: { header: { config: { provider: 'sjtu', model: 'test' } } } },
]
let invariantInstall
const invariantContext = {
  invariants: { register(_name, install) { invariantInstall = install; return () => {} } },
}
await retryInvariant.apply(invariantContext)
const validations = []
const session = { snapshotEvents: () => [...events], append(type, data) {
  const event = { type, data }
  for (const validate of validations) validate('emit', 'session/event', [session, event])
  events.push(event)
} }
invariantInstall({ sessions: { list: () => [] }, on(name, callback) {
  if (name === 'internal/dispatch') validations.push(callback)
} }, reason => { throw new Error(`Native retry invariant: ${reason}`) })
const agent = { session }
const signal = new AbortController().signal
let finalChunks
for (let i = 0; i < 7; i++) {
  // Exercise the real registration-bound prepareCall + waterfall + adapter dispatch path.
  const prepared = await llm.prepareCall({ provider: 'sjtu', model: 'test' }, signal)
  finalChunks = []
  for await (const chunk of prepared.stream({ ...prepared.config, signal, messages: [] })) finalChunks.push(chunk)
  const finish = finalChunks.findLast(chunk => chunk.type === 'finish')
  if (finish.reason.kind === 'stop') break
  assert.equal(finish.reason.failure.code, 'RATE_LIMIT')
  const decision = await context.waterfall('agent/request-error', { agent, turn: 1, step: 1,
    provider: 'sjtu', failure: finish.reason.failure, signal }, () => undefined)
  assert.deepEqual(decision, { kind: 'retry' })
}
assert.equal(dispatches, 7)
assert.equal(controller.snapshot().weeklyLocalTokens, 310)
assert.equal(events.filter(event => event.type === 'llm/retry').length, 6)
assert.ok(finalChunks.some(chunk => chunk.text === 'continued'))
await hookCleanup()

// Test actual settings namespace registration, schema validation and hot updates.
const settingsContext = new Context()
new LlmRuntime(settingsContext)
new CommandRuntime(settingsContext)
const modern = settingsModule.SettingsProvider === undefined
const tempRoot = resolve(fileURLToPath(new URL(`../.test-state/${modern ? 'modern' : 'legacy'}`, import.meta.url)))
mkdirSync(tempRoot, { recursive: true })
let settings
const entry = { id: 'sjtu-quota', options: { id: 'sjtu-quota', config: { providers: ['sjtu'], stateFile: join(tempRoot, 'ledger.json') } } }
if (modern) {
  settingsContext.provide('profileContext', { home: tempRoot, name: 'isolated-test' })
  settingsContext.provide('loader', { await: () => Promise.resolve() })
  settingsContext.provide('configEditor', {
    documentPath: join(tempRoot, 'cordis.patch.yml'),
    configuration: () => entry.fiber ? [{ entry, inherited: {}, override: entry.options.config }] : [],
    entries: () => [entry],
    async edit(target, update) {
      target.options.config = update(target.options.config, {})
      await target.fiber.update(target.options.config)
      await target.fiber.await()
      if (target.fiber.error) throw target.fiber.error
    },
  })
  settings = new settingsModule.SettingsForms(settingsContext)
} else {
  class MemorySettings extends settingsModule.SettingsProvider {
    get writable() { return true }
    load() { return Promise.resolve({}) }
    persist() { return Promise.resolve() }
  }
  settings = new MemorySettings(settingsContext)
}
const entryFiber = settingsContext.plugin(plugin, entry.options.config)
entry.fiber = entryFiber
await entryFiber.await()
assert.equal(entryFiber.error, undefined)
const settingsValue = () => modern ? settings.describe().find(form => form.ns === 'sjtu-quota')?.value : settings.get('sjtu-quota')
assert.equal(settingsValue().tokensPerMinute, 300000)
await settings.update('sjtu-quota', { requestsPerMinute: 8 })
assert.equal(settingsValue().requestsPerMinute, 8)
await entryFiber.dispose()
assert.equal(JSON.parse(readFileSync(join(tempRoot, 'ledger.json'), 'utf8')).version, 2)
console.log(JSON.stringify({ host: readFileSync(join(host, 'package.json'), 'utf8') ? host : '',
  realAdapterCalls: dispatches, rateLimitRecoveries: controller.stats.retries,
  recordedTokens: controller.snapshot().weeklyLocalTokens, nativeRetryInvariants: 'passed', settings: 'passed', nativePluginLifecycle: 'passed' }))
