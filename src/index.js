import z from '@deepseek-ai/schemastery'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULTS, configWithDefaults, resolveProviders, QuotaController } from './quota.js'
import { openStateStore } from './state.js'
import { installHooks } from './plugin.js'

export const name = 'sjtu-quota'
export const inject = ['llm', 'settings', 'commands']
const require = createRequire(import.meta.url)
const cordisVersion = JSON.parse(readFileSync(require.resolve('@deepseek-ai/cordis/package.json'), 'utf8')).version.split('.').map(Number)
const modernConfig = cordisVersion[0] > 4 || (cordisVersion[0] === 4 && (cordisVersion[1] > 0 || cordisVersion[2] >= 4))
const fields = {
  enabled: z.boolean().default(true).description('启用请求排队和 429 恢复'),
  providers: z.array(z.string()).default([]).description('手动指定共享额度的路由 ID；留空自动识别上交接口'),
  autoDetect: z.boolean().default(true).description('按接口域名自动识别上交路由，不读取 API Key'),
  endpointHosts: z.array(z.string()).default(DEFAULTS.endpointHosts).description('自动识别的接口域名，精确匹配'),
  tokensPerMinute: z.number().step(1).min(1).default(300000),
  requestsPerMinute: z.number().step(1).min(1).default(10),
  weeklyTokens: z.number().step(1).min(1).default(1000000000),
  safetyRatio: z.number().min(0.01).max(1).default(0.9).description('默认使用 90% 的分钟额度，保留估算余量'),
  estimateMultiplier: z.number().min(1).max(10).default(1.15),
  fallbackOutputTokens: z.number().step(1).min(1).default(8192),
  maxConcurrent: z.number().step(1).min(1).default(1),
  fallbackWaitMs: z.number().step(1).min(1000).default(61000),
  stateFile: z.string().default('').description('空值使用 DSH 数据目录中的独立账本；修改后重启插件'),
}
// Cordis 4.0.4+ serves volatile Config fields directly as native settings forms.
// Older hosts keep their settings namespace contract and ordinary schema values.
if (modernConfig) for (const [key, schema] of Object.entries(fields)) {
  if (key !== 'stateFile' && typeof schema.volatile === 'function') fields[key] = schema.volatile()
}
export const Config = z.object(fields)

export function plainOptions(value = {}) {
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [key,
    field && typeof field.get === 'function' ? field.get() : field]))
}

function profilesFrom(settings) {
  if (typeof settings?.get === 'function') return settings.get('llm-pi-ai')?.providers ?? {}
  if (typeof settings?.describe !== 'function') return {}
  const forms = settings.describe({ redactSecrets: true })
  return Object.assign({}, ...forms.filter(form => form.value?.providers && !Array.isArray(form.value.providers))
    .map(form => form.value.providers))
}

export function apply(ctx, base = {}) {
  const settings = ctx.get?.('settings')
  const scope = typeof settings?.register === 'function' ? settings.register(name, Config, { base }) : undefined
  const readConfig = () => configWithDefaults(plainOptions(scope?.get() ?? base))
  const config = readConfig()
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const file = config.stateFile ? resolve(config.stateFile) : join(home, 'storages', 'sjtu-quota', 'ledger.json')
  const store = openStateStore(file)
  let controller
  let disposeHooks
  const effective = value => ({ ...value, providers: resolveProviders(value, profilesFrom(settings)) })
  try {
    controller = new QuotaController({ config: effective(config), state: store.state, save: value => store.save(value),
      onWait: wait => ctx.logger?.info(`SJTU：${wait.reason}；预计请求 ${wait.estimatedTokens} Token`) })
    disposeHooks = installHooks(ctx, controller, new AbortController(), () => controller.update(effective(readConfig())))
  } catch (error) { store.close(); throw error }
  const unwatch = scope?.watch(value => {
    if (value.stateFile !== config.stateFile) ctx.logger?.warn('额度账本路径变更将在重启插件后生效')
    controller.update(effective(value))
  })
  const unwatchRoutes = ctx.on('settings/updated', (namespace) => {
    if (namespace === 'llm-pi-ai') controller.update(effective(readConfig()))
  })
  ctx.effect(() => async () => {
    unwatch?.()
    unwatchRoutes()
    try { await disposeHooks(); controller.persist() } finally { store.close() }
  }, 'sjtu-quota: cancel queued requests and persist accounting')
}
