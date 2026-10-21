import { randomUUID } from 'node:crypto'
import { QuotaController, isTransientRateLimit, RequestTooLargeError } from './quota.js'

export function installHooks(ctx, controller, lifetime = new AbortController(), refresh = () => {}) {
  const agentRetries = new WeakMap()
  const active = new Set()
  function fused(signal) { return signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal }
  function track(promise) {
    active.add(promise)
    promise.finally(() => active.delete(promise)).catch(() => {})
    return promise
  }
  const disposeStream = ctx.on('llm/stream', (options, next) => {
    refresh()
    if (!controller.matches(options.provider)) return next()
    return (async function* () {
      const signal = fused(options.signal)
      let permit
      let usage
      let outcome = 'interrupted'
      let done
      const operation = new Promise(resolve => { done = resolve })
      active.add(operation)
      try {
        try {
          permit = await controller.acquire(options, signal)
        } catch (error) {
          if (!(error instanceof RequestTooLargeError)) throw error
          yield { type: 'finish', reason: { kind: 'error', failure: { code: error.code, message: error.message } } }
          return
        }
        signal.throwIfAborted()
        for await (const chunk of next()) {
          signal.throwIfAborted()
          if (chunk.type === 'usage') usage = chunk.usage
          if (chunk.type === 'finish') {
            if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
              if (isTransientRateLimit(chunk.reason.failure)) {
                outcome = 'rate-limit'
                controller.rateLimited(chunk.reason.failure)
              } else outcome = 'failed'
            } else outcome = 'success'
          }
          yield chunk
        }
      } finally {
        try { if (permit) controller.settle(permit, usage, outcome) }
        finally { done(); active.delete(operation) }
      }
    })()
  })
  const disposeRecovery = ctx.on('agent/request-error', (payload, next) => {
    refresh()
    if (!controller.matches(payload.provider) || !isTransientRateLimit(payload.failure)) return next()
    return track((async () => {
      const signal = fused(payload.signal)
      if (signal.aborted) return
      if (controller.cooldownUntil <= controller.now()) controller.rateLimited(payload.failure)
      const current = agentRetries.get(payload.agent)
      const sameStep = current?.turn === payload.turn && current?.step === payload.step && current?.provider === payload.provider
      const persisted = payload.agent.session.snapshotEvents?.().findLast(event => event.type === 'llm/retry' &&
        event.data.policyKey === 'dsh-sjtu-quota-v1' && event.data.provider === payload.provider &&
        event.data.turn === payload.turn && event.data.step === payload.step)?.data
      const previous = persisted ?? (sameStep ? current : undefined)
      const retry = (previous?.retry ?? 0) + 1
      const retryId = previous?.retryId ?? randomUUID()
      agentRetries.set(payload.agent, { turn: payload.turn, step: payload.step, provider: payload.provider, retry, retryId })
      const delayMs = Math.max(1, controller.cooldownUntil - controller.now())
      // Reuse the official durable retry protocol so DSH's existing chat UI shows the wait.
      const event = { retryId, turn: payload.turn, step: payload.step, provider: payload.provider,
        mode: 'always', policyKey: 'dsh-sjtu-quota-v1', retry, delayMs: Math.min(delayMs, 2_147_483_647),
        failure: { code: 'RATE_LIMIT', message: `上交 API 每分钟限流，等待 ${Math.ceil(delayMs / 1000)} 秒后自动继续。`,
          ...(payload.failure.status === undefined ? {} : { status: payload.failure.status }) } }
      payload.agent.session.append('llm/retry', event)
      await controller.waitForCooldown(signal)
      signal.throwIfAborted()
      payload.agent.session.append('llm/retry-started', { retryId, turn: payload.turn, step: payload.step, retry })
      controller.stats.retries++
      controller.persist()
      return { kind: 'retry' }
    })())
  }, { prepend: true })
  const commands = ctx.get?.('commands')
  const disposeCommand = commands?.register({
    name: 'sjtu-quota', description: '查看上交 API 分钟额度、排队状态和本地七天 Token 统计',
    handler: async () => {
      refresh()
      const state = controller.snapshot()
      const formatter = new Intl.NumberFormat('zh-CN')
      return { kind: 'success', text: [
        `上交 API：分钟 Token 已用/预留 ${formatter.format(state.tokensReservedOrUsed)}；调度预算 ${formatter.format(state.admissionLimit)}；上限 ${formatter.format(state.tokenLimit)}`,
        `受保护路由：${controller.config.providers.join('、') || '未识别到；请检查接口域名或手动填写 providers'}`,
        `分钟请求 ${state.requestsInMinute}/${state.requestLimit}；进行中 ${state.inFlight}；排队 ${state.queued}；冷却剩余 ${Math.ceil(state.cooldownMs / 1000)} 秒`,
        `本地七天已用/预留 ${formatter.format(state.weeklyLocalTokens)}/${formatter.format(state.weeklyLimit)}；记录起始 ${new Date(state.trackingSince).toLocaleString('zh-CN')}`,
        `完成 ${state.stats.completed} 次；遇到限流 ${state.stats.rateLimits} 次；自动恢复 ${state.stats.retries} 次；缺少真实用量而保留预估 ${state.stats.estimatedCalls} 次`,
        ...state.waiters.map(wait => `${wait.provider}：${wait.reason}，预计请求 ${formatter.format(wait.estimatedTokens)} Token`),
        '统计范围：本插件运行后的所选路由；不包含其他软件/电脑和安装前用量。七天统计为本地滚动预算，不代表学校账号真实周余额。',
      ].join('\n') }
    },
  })
  return async () => {
    disposeStream(); disposeRecovery(); disposeCommand?.()
    lifetime.abort(new DOMException('Quota plugin disposed', 'AbortError'))
    await Promise.allSettled([...active])
  }
}
