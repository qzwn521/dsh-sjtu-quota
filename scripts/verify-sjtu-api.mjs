// Optional live smoke test: fixed synthetic input, at most one generation.
// No key, response error body, conversation or request headers are written to disk.
const key = process.env.SJTU_API_KEY?.trim()
if (!key) {
  console.log(JSON.stringify({ status: 'not-run', reason: 'SJTU_API_KEY is not set' }))
  process.exit(2)
}
const base = 'https://models.sjtu.edu.cn/api/v1'
async function request(path, body) {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', redirect: 'error',
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw Object.assign(new Error('Upstream rejected smoke test'), { status: response.status })
  return response.json()
}
try {
  const models = await request('/models')
  const ids = (models.data ?? []).map(model => model.id).filter(id => typeof id === 'string')
  const model = ids.find(id => id === 'qwen3.8-27b') ?? ids.find(id => /qwen/i.test(id) && !/thinking|reason|vl|embed|rerank/i.test(id))
  if (!model) throw new Error('No suitable Qwen text model listed; no generation sent')
  const result = await request('/chat/completions', { model, messages: [{ role: 'user', content: 'Reply with the number 2 only.' }], max_tokens: 16, stream: false })
  const usage = result.usage ?? {}
  const count = value => Number.isFinite(value) && value >= 0 ? value : null
  console.log(JSON.stringify({ status: 'passed', model, modelsListed: ids.length,
    contentReceived: Boolean(result.choices?.[0]?.message?.content), usage: {
      promptTokens: count(usage.prompt_tokens), completionTokens: count(usage.completion_tokens), totalTokens: count(usage.total_tokens) },
    scope: 'API authentication, text generation and usage only; no deliberate rate-limit load' }))
} catch (error) {
  console.log(JSON.stringify({ status: 'failed', httpStatus: error.status ?? null,
    reason: error.status ? 'upstream-http-error' : error.name === 'TimeoutError' ? 'timeout' : 'network-or-model-discovery-error' }))
  process.exitCode = 1
}
