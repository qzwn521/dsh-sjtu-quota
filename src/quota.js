import { randomUUID } from 'node:crypto'

export const MINUTE = 60_000
export const WEEK = 7 * 24 * 60 * MINUTE
const HOUR = 60 * MINUTE
export const DEFAULTS = Object.freeze({
  enabled: true,
  providers: [],
  autoDetect: true,
  endpointHosts: ['models.sjtu.edu.cn'],
  tokensPerMinute: 300_000,
  requestsPerMinute: 10,
  weeklyTokens: 1_000_000_000,
  safetyRatio: 0.9,
  estimateMultiplier: 1.15,
  fallbackOutputTokens: 8192,
  maxConcurrent: 1,
  fallbackWaitMs: 61_000,
  stateFile: '',
})

export function configWithDefaults(value = {}) {
  const result = { ...DEFAULTS, ...value }
  for (const key of ['tokensPerMinute', 'requestsPerMinute', 'weeklyTokens',
    'fallbackOutputTokens', 'maxConcurrent', 'fallbackWaitMs']) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1) throw new TypeError(`Invalid ${key}`)
  }
  if (!(result.safetyRatio > 0 && result.safetyRatio <= 1)) throw new TypeError('Invalid safetyRatio')
  if (!(result.estimateMultiplier >= 1 && result.estimateMultiplier <= 10)) throw new TypeError('Invalid estimateMultiplier')
  if (!Array.isArray(result.providers) || result.providers.some(x => typeof x !== 'string' || !x.trim())) {
    throw new TypeError('providers must contain route IDs')
  }
  if (typeof result.enabled !== 'boolean' || typeof result.autoDetect !== 'boolean') throw new TypeError('Invalid enable flags')
  if (!Array.isArray(result.endpointHosts) || result.endpointHosts.some(host => typeof host !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host))) throw new TypeError('Invalid endpointHosts')
  return result
}

export function resolveProviders(config, providerProfiles = {}) {
  // Explicit routes win. Detect from endpoint host, never a personal route name or API key.
  if (config.providers.length > 0) return [...new Set(config.providers)]
  if (!config.autoDetect) return []
  const hosts = new Set(config.endpointHosts.map(host => host.toLowerCase()))
  return Object.entries(providerProfiles).flatMap(([id, profile]) => {
    try {
      const url = new URL(profile?.baseURL)
      return ['https:', 'http:'].includes(url.protocol) && hosts.has(url.hostname.toLowerCase()) ? [id] : []
    } catch { return [] }
  })
}

export function usageCounts(usage) {
  if (!usage || typeof usage !== 'object') return null
  const names = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
  for (const key of names) {
    if (usage[key] !== undefined && (!Number.isSafeInteger(usage[key]) || usage[key] < 0)) return null
  }
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) return null
  const input = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  // DSH buckets are disjoint; reasoning is already included in output.
  const sum = input + usage.outputTokens
  if (!Number.isSafeInteger(sum)) return null
  // Preserve a larger authoritative total, never undercount a known bucket sum.
  const total = Number.isSafeInteger(usage.totalTokens) && usage.totalTokens >= sum ? usage.totalTokens : sum
  return { input, output: usage.outputTokens, cacheRead: usage.cacheReadTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0, reasoning: usage.reasoningTokens ?? 0, total }
}

function textWeight(text) {
  let wide = 0
  let other = 0
  for (const char of String(text)) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) wide++
    else other++
  }
  return wide * 1.5 + other / 3
}

// This is deliberately labelled an estimate: no provider tokenizer is available here.
export function lexicalInputEstimate(options) {
  function blocks(content) {
    if (typeof content === 'string') return textWeight(content)
    if (!Array.isArray(content)) return 0
    return content.reduce((sum, block) => {
      if (!block || typeof block !== 'object') return sum
      if (block.type === 'image') return sum + 4096
      if (block.type === 'file') return sum + 256 + textWeight(block.attachment?.name ?? '')
      if (block.type === 'tool-result') return sum + 12 + blocks(block.content)
      return sum + 8 + textWeight(block.text ?? '') + textWeight(block.arguments ?? '') + textWeight(block.name ?? '')
    }, 0)
  }
  const messages = (options.messages ?? []).reduce((sum, message) => sum + 12 + blocks(message.content), 0)
  const tools = options.tools === undefined ? 0 : textWeight(JSON.stringify(options.tools))
  return Math.max(1, Math.ceil(messages + tools + textWeight(options.systemPrompt ?? '') + 64))
}

export function isTransientRateLimit(failure) {
  if (!failure || (failure.code !== 'RATE_LIMIT' && failure.status !== 429)) return false
  if (['QUOTA', 'ACCOUNT_QUOTA', 'AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'CONTEXT_WINDOW_EXCEEDED',
    'SJTU_REQUEST_TOO_LARGE'].includes(failure.code)) return false
  const text = String(failure.message ?? '')
  if (/insufficient[\s_-]*(quota|balance)|quota[\s_-]*(exceeded|exhausted)|budget.*exceeded|limit type:\s*(budget|quota)|weekly|per.week|每周|余额不足|额度耗尽/i.test(text)) return false
  // SJTU's documented weekly token cap can use the same LiteLLM error wording.
  const currentLimit = text.match(/Current limit:\s*(\d+)/i)
  if (/Limit type:\s*tokens/i.test(text) && Number(currentLimit?.[1]) === 1_000_000_000) return false
  return true
}

export function rateLimitWaitMs(failure, now, fallback = 61_000) {
  // Relative server advice wins over absolute wall-clock dates.
  if (Number.isFinite(failure?.providerRetryAfterMs) && failure.providerRetryAfterMs > 0) {
    return Math.ceil(failure.providerRetryAfterMs) + 1000
  }
  const match = String(failure?.message ?? '').match(/Limit resets at:\s*(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(?:\.\d+)?\s*(UTC|Z|[+-]\d\d:\d\d)/i)
  if (match) {
    const time = Date.parse(`${match[1]}T${match[2]}${/^(UTC|Z)$/i.test(match[3]) ? 'Z' : match[3]}`)
    const delay = time - now
    // A per-minute window hours in the future indicates a clock/timezone mismatch.
    if (delay > 0 && delay <= 120_000) return Math.ceil(delay) + 1000
  }
  return fallback
}

export function cancellableSleep(ms, signal) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const duration = Math.min(Math.max(1, ms), 2_147_483_647)
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason ?? new DOMException('Cancelled', 'AbortError')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, duration)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

export class RequestTooLargeError extends Error {
  code = 'SJTU_REQUEST_TOO_LARGE'
  constructor(tokens, limit) {
    super(`预计输入与输出预留合计 ${tokens.toLocaleString()} Token，超过本插件单分钟预算 ${limit.toLocaleString()}。等待无法解决单次请求过大；请压缩上下文、降低输出上限，或调整安全余量。`)
  }
}

export class QuotaController {
  constructor({ config = DEFAULTS, now = Date.now, sleep = cancellableSleep, save = () => {}, state, onWait = () => {} } = {}) {
    this.config = configWithDefaults(config)
    this.now = now
    this.sleep = sleep
    this.save = save
    this.onWait = onWait
    this.records = []
    this.history = []
    this.queue = []
    this.anchors = new Map()
    this.cooldownUntil = 0
    this.waiters = new Map()
    this.stats = { rateLimits: 0, retries: 0, completed: 0, estimatedCalls: 0 }
    this.trackingSince = now()
    if (state) this.restore(state)
  }
  matches(provider) { return this.config.enabled && this.config.providers.includes(provider) }
  update(config) { this.config = configWithDefaults(config) }
  prune() {
    const current = this.now()
    const buckets = new Map(this.history.filter(bucket => bucket.expiresAt > current)
      .map(bucket => [bucket.expiresAt, bucket.tokens]))
    this.records = this.records.filter(record => {
      if (record.pending || record.settledAt + MINUTE > current) return true
      const expiresAt = Math.floor(record.settledAt / HOUR) * HOUR + HOUR + WEEK
      if (record.tokens > 0 && expiresAt > current) buckets.set(expiresAt, (buckets.get(expiresAt) ?? 0) + record.tokens)
      return false
    })
    this.history = [...buckets].map(([expiresAt, tokens]) => ({ expiresAt, tokens }))
      .sort((a, b) => a.expiresAt - b.expiresAt)
  }
  persist() { this.prune(); this.save(this.exportState()) }
  exportState() {
    return { version: 2, trackingSince: this.trackingSince, cooldownUntil: this.cooldownUntil,
      stats: { ...this.stats }, records: this.records.map(r => ({ ...r })),
      history: this.history.map(bucket => ({ ...bucket })), anchors: [...this.anchors] }
  }
  restore(state) {
    if (![1, 2].includes(state.version) || !Array.isArray(state.records)) throw new TypeError('Unknown quota state format')
    const current = this.now()
    this.trackingSince = Number.isFinite(state.trackingSince) ? state.trackingSince : current
    this.cooldownUntil = Number.isFinite(state.cooldownUntil) ? state.cooldownUntil : 0
    this.records = state.records.filter(r => r && typeof r.id === 'string' &&
      Number.isFinite(r.startedAt) && Number.isFinite(r.settledAt) && Number.isSafeInteger(r.tokens) && r.tokens >= 0)
      .map(r => ({ ...r, pending: false, settledAt: r.pending ? current : r.settledAt }))
    this.history = (state.history ?? []).filter(bucket => Number.isFinite(bucket.expiresAt) &&
      Number.isSafeInteger(bucket.tokens) && bucket.tokens >= 0).map(bucket => ({ ...bucket }))
    for (const [key, anchor] of state.anchors ?? []) {
      if (typeof key === 'string' && anchor?.ratio >= 1 && anchor.ratio <= 20) this.anchors.set(key, anchor)
    }
    for (const key of Object.keys(this.stats)) {
      if (Number.isSafeInteger(state.stats?.[key]) && state.stats[key] >= 0) this.stats[key] = state.stats[key]
    }
    this.prune()
  }
  estimate(options) {
    const lexical = lexicalInputEstimate(options)
    const key = JSON.stringify([options.provider, options.model])
    const anchor = this.anchors.get(key)
    const prompt = Math.ceil(lexical * Math.max(this.config.estimateMultiplier, anchor?.ratio ?? 1))
    const output = Number.isSafeInteger(options.maxTokens) && options.maxTokens > 0 ? options.maxTokens : this.config.fallbackOutputTokens
    return { lexical, prompt, output, tokens: prompt + output, anchorKey: key }
  }
  snapshot() {
    this.prune()
    const current = this.now()
    const minute = this.records.filter(r => r.pending || r.settledAt + MINUTE > current)
    return { tokenLimit: this.config.tokensPerMinute, admissionLimit: Math.floor(this.config.tokensPerMinute * this.config.safetyRatio),
      tokensReservedOrUsed: minute.reduce((sum, r) => sum + r.tokens, 0),
      requestsInMinute: this.records.filter(r => r.startedAt + MINUTE > current).length,
      requestLimit: this.config.requestsPerMinute, inFlight: this.records.filter(r => r.pending).length,
      queued: this.queue.length, weeklyLocalTokens: this.records.reduce((sum, r) => sum + r.tokens, 0) +
        this.history.reduce((sum, bucket) => sum + bucket.tokens, 0),
      weeklyLimit: this.config.weeklyTokens, trackingSince: this.trackingSince,
      cooldownMs: Math.max(0, this.cooldownUntil - current),
      waiters: [...this.waiters.values()], stats: { ...this.stats } }
  }
  delayFor(tokens, ticket) {
    const current = this.now()
    const snapshot = this.snapshot()
    if (this.queue[0] !== ticket || snapshot.inFlight >= this.config.maxConcurrent) return { ms: 250, reason: '并发排队' }
    if (this.cooldownUntil > current) return { ms: this.cooldownUntil - current, reason: '等待服务端限流恢复' }
    if (snapshot.requestsInMinute >= this.config.requestsPerMinute) {
      const oldest = Math.min(...this.records.filter(r => r.startedAt + MINUTE > current).map(r => r.startedAt))
      return { ms: oldest + MINUTE + 1000 - current, reason: '每分钟请求次数不足' }
    }
    if (snapshot.tokensReservedOrUsed + tokens > snapshot.admissionLimit) {
      const settled = this.records.filter(r => !r.pending && r.settledAt + MINUTE > current)
      return { ms: settled.length ? Math.min(...settled.map(r => r.settledAt)) + MINUTE + 1000 - current : 250,
        reason: '每分钟 Token 余量不足' }
    }
    if (snapshot.weeklyLocalTokens + tokens > this.config.weeklyTokens) {
      const settled = this.records.filter(r => !r.pending)
      const expiries = [...settled.map(record => record.settledAt + WEEK), ...this.history.map(bucket => bucket.expiresAt)]
      return { ms: expiries.length ? Math.min(...expiries) + 1000 - current : 250,
        reason: '本地七天用量预算不足' }
    }
    return null
  }
  async acquire(options, signal) {
    const estimate = this.estimate(options)
    const limit = Math.floor(this.config.tokensPerMinute * this.config.safetyRatio)
    if (estimate.tokens > limit || estimate.tokens > this.config.weeklyTokens) throw new RequestTooLargeError(estimate.tokens, Math.min(limit, this.config.weeklyTokens))
    const ticket = randomUUID()
    this.queue.push(ticket)
    let notified = ''
    try {
      while (true) {
        signal?.throwIfAborted()
        const currentLimit = Math.min(Math.floor(this.config.tokensPerMinute * this.config.safetyRatio), this.config.weeklyTokens)
        if (estimate.tokens > currentLimit) throw new RequestTooLargeError(estimate.tokens, currentLimit)
        const wait = this.delayFor(estimate.tokens, ticket)
        if (!wait) {
          const record = { id: ticket, provider: options.provider, model: options.model,
            startedAt: this.now(), settledAt: this.now(), tokens: estimate.tokens, pending: true,
            estimated: true }
          this.records.push(record)
          this.persist()
          return { id: ticket, estimate }
        }
        this.waiters.set(ticket, { provider: options.provider, reason: wait.reason,
          until: this.now() + wait.ms, estimatedTokens: estimate.tokens })
        if (notified !== wait.reason) { this.onWait(this.waiters.get(ticket)); notified = wait.reason }
        // Recheck at most once a second so cancellation and changed cooldowns take effect.
        await this.sleep(Math.min(wait.ms, 1000), signal)
      }
    } finally {
      this.waiters.delete(ticket)
      this.queue = this.queue.filter(id => id !== ticket)
    }
  }
  settle(permit, usage, outcome = 'success') {
    const record = this.records.find(r => r.id === permit.id)
    if (!record || !record.pending) return
    const counts = usageCounts(usage)
    if (counts && (counts.total > 0 || outcome === 'success')) {
      record.tokens = counts.total
      record.estimated = false
      record.usage = counts
      if (counts.input > 0) {
        this.anchors.set(permit.estimate.anchorKey, {
          ratio: Math.max(this.config.estimateMultiplier, Math.min(20, counts.input / permit.estimate.lexical * 1.05))
        })
      }
    } else if (outcome === 'rate-limit') {
      // Rejected before generation: keep its RPM slot, don't invent billed tokens.
      record.tokens = 0
      record.estimated = true
    } else this.stats.estimatedCalls++
    record.pending = false
    record.settledAt = this.now()
    if (outcome === 'success') this.stats.completed++
    this.persist()
  }
  rateLimited(failure) {
    const wait = rateLimitWaitMs(failure, this.now(), this.config.fallbackWaitMs)
    this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + wait)
    this.stats.rateLimits++
    this.persist()
    return wait
  }
  async waitForCooldown(signal) {
    while (this.cooldownUntil > this.now()) {
      signal?.throwIfAborted()
      await this.sleep(Math.min(1000, this.cooldownUntil - this.now()), signal)
    }
  }
}
