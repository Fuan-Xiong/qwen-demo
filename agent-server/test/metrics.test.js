// agent-server/test/metrics.test.js —— metrics 层测试（node:test + node:assert/strict）
// 覆盖：累加正确（tokens/stages/rules/llmCalls/skills）；snapshot 可 JSON 序列化；
//       logger 一行一条 JSON、约定字段齐全、key 脱敏、tokens 字段不被误杀。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMetrics } from '../src/metrics/metrics.js'
import { createLogger, redact, isSensitiveKey } from '../src/metrics/logger.js'

// ── metrics ─────────────────────────────────────────────

test('tokens 累加正确：多轮 addTokens 汇总，estimated 任一 true 即整体标记', () => {
  const m = createMetrics()
  m.addTokens({ prompt: 100, completion: 20 })
  m.addTokens({ prompt: 50, completion: 30 })
  assert.deepEqual(m.snapshot().tokens, { prompt: 150, completion: 50, total: 200, estimated: false })

  const m2 = createMetrics()
  m2.addTokens({ prompt: 10, completion: 5, estimated: true })
  m2.addTokens({ prompt: 3, completion: 1 })
  assert.equal(m2.snapshot().tokens.estimated, true, '任一次估算即整体标记 estimated')
  assert.equal(m2.snapshot().tokens.total, 19)
})

test('addLlmCall 联动 tokens（OpenAI 兼容 usage 字段）', () => {
  const m = createMetrics()
  m.addLlmCall()
  m.addLlmCall({ prompt_tokens: 100, completion_tokens: 25 })
  m.addLlmCall({ input_tokens: 30, output_tokens: 5 })
  const s = m.snapshot()
  assert.equal(s.llmCalls, 3)
  assert.deepEqual(s.tokens, { prompt: 130, completion: 30, total: 160, estimated: false })
})

test('stages/rules/skills 计数正确（含未知规则状态兜底）', () => {
  const m = createMetrics()
  m.addStage('PARSING', 12)
  m.addStage('PARSING', 8)
  m.addStage('EXECUTING', 100)
  assert.deepEqual(m.snapshot().stages, { PARSING: 20, EXECUTING: 100 })

  m.addRuleResult('pass')
  m.addRuleResult('fail')
  m.addRuleResult('review')
  m.addRuleResult('pass')
  m.addRuleResult('weird-status') // 未知状态 → failed 兜底
  assert.deepEqual(m.snapshot().rules, { total: 5, pass: 2, fail: 1, review: 1, failed: 1 })

  m.addSkill('parse-document')
  m.addSkill('parse-document')
  m.addSkill('compare/amount')
  assert.deepEqual(m.snapshot().skills, { 'parse-document': { calls: 2 }, 'compare/amount': { calls: 1 } })
})

test('snapshot 可 JSON 序列化且 elapsedMs 非负', () => {
  const m = createMetrics()
  m.addTokens({ prompt: 1, completion: 1 })
  m.addStage('INIT', 1)
  m.addLlmCall({ prompt_tokens: 1 })
  m.addRuleResult('pass')
  m.addSkill('x')
  const snap = m.snapshot()
  assert.ok(snap.elapsedMs >= 0)
  assert.doesNotThrow(() => JSON.stringify(snap), 'snapshot 必须可 JSON 序列化')
  // 无函数/undefined/Map 泄漏到 JSON
  const json = JSON.stringify(snap)
  assert.ok(!json.includes('undefined'))
  assert.ok(!json.includes('function'))
})

// ── logger ──────────────────────────────────────────────

test('logger：一行一条 JSON 且可解析，约定字段齐全', () => {
  const lines = []
  const log = createLogger({ stream: { write: (s) => lines.push(s) } })
  log.log({ runId: 'r1', stage: 'EXECUTING', event: 'llm_call', ruleId: 'R1', elapsedMs: 12, tokens: { prompt: 10, completion: 5 }, errorCode: null, detail: { note: 'ok' } })
  assert.equal(lines.length, 1)
  // 单行输出：行尾有且仅有一个换行分隔符（中间不得有真实换行，否则 JSON 不可解析）
  assert.equal(lines[0].endsWith('\n'), true)
  assert.equal((lines[0].slice(0, -1).match(/\n/g) ?? []).length, 0, 'JSON 主体不得含换行')
  const obj = JSON.parse(lines[0])
  assert.equal(obj.level, 'info')
  assert.equal(obj.runId, 'r1')
  assert.equal(obj.stage, 'EXECUTING')
  assert.equal(obj.event, 'llm_call')
  assert.equal(obj.ruleId, 'R1')
  assert.equal(obj.elapsedMs, 12)
  assert.deepEqual(obj.tokens, { prompt: 10, completion: 5 })
  assert.equal(obj.errorCode, null)
})

test('logger：key 脱敏——apiKey/secret 等被替换为 [REDACTED]，输出不含明文', () => {
  const lines = []
  const log = createLogger({ stream: { write: (s) => lines.push(s) } })
  log.log({
    runId: 'r1',
    detail: { apiKey: 'sk-secret-123', nested: { innerSecret: 'deep-secret' }, safe: 'hello' },
  })
  const raw = lines[0]
  assert.ok(!raw.includes('sk-secret-123'), '不得输出 apiKey 明文')
  assert.ok(!raw.includes('deep-secret'), '不得输出嵌套 secret 明文')
  const obj = JSON.parse(raw)
  assert.equal(obj.detail.apiKey, '[REDACTED]')
  assert.equal(obj.detail.nested.innerSecret, '[REDACTED]')
  assert.equal(obj.detail.safe, 'hello')
})

test('logger：tokens 字段不被误杀（token 用量是复跑参数，非敏感键）', () => {
  assert.equal(isSensitiveKey('tokens'), false)
  assert.equal(isSensitiveKey('apiKey'), true)
  assert.equal(isSensitiveKey('QWEN_API_KEY'), true)
  assert.equal(isSensitiveKey('accessToken'), true)
  assert.equal(isSensitiveKey('secret'), true)
  const lines = []
  const log = createLogger({ stream: { write: (s) => lines.push(s) } })
  log.log({ tokens: { prompt: 10, completion: 20, total: 30 }, apiKey: 'k-secret' })
  const obj = JSON.parse(lines[0])
  assert.deepEqual(obj.tokens, { prompt: 10, completion: 20, total: 30 })
  assert.equal(obj.apiKey, '[REDACTED]')
})

test('redact：数组与嵌套对象递归脱敏，普通值原样', () => {
  const out = redact({ a: { apiKey: 'x' }, list: [{ password: 'y' }, { name: 'z' }], n: 42 })
  assert.deepEqual(out, { a: { apiKey: '[REDACTED]' }, list: [{ password: '[REDACTED]' }, { name: 'z' }], n: 42 })
})

test('logger：info/warn/error 带 level', () => {
  const lines = []
  const log = createLogger({ stream: { write: (s) => lines.push(s) } })
  log.info({ event: 'a' })
  log.warn({ event: 'b' })
  log.error({ event: 'c' })
  assert.deepEqual(lines.map((l) => JSON.parse(l).level), ['info', 'warn', 'error'])
})