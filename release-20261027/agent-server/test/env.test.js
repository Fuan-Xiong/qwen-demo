// agent-server/test/env.test.js —— config/env.js 测试（node:test + node:assert/strict）
// 注意：env.js 模块加载时会 fail fast 读真实 process.env，因此必须先注入必填项再动态导入。

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.QWEN_API_KEY = process.env.QWEN_API_KEY ?? 'test-key'
process.env.MODEL_NAME = process.env.MODEL_NAME ?? 'test-model'
const { loadEnv, ConfigError, config, snapshot } = await import('../src/config/env.js')

/** 必填齐全的基准环境（其余走默认） */
const BASE = { QWEN_API_KEY: 'k1', MODEL_NAME: 'm1' }

test('默认值：提供必填项，其余字段走默认', () => {
  const { config: c } = loadEnv(BASE)
  assert.equal(c.server.host, '127.0.0.1')
  assert.equal(c.server.port, 4170)
  assert.equal(c.qwen.apiKey, 'k1')
  assert.equal(c.qwen.baseURL, '')
  assert.equal(c.model.name, 'm1')
  assert.equal(c.model.temperature, 0.2)
  assert.equal(c.model.maxTokens, 4096)
  assert.equal(c.harness.timeoutMs, 90_000)
  assert.equal(c.harness.retries, 2)
  assert.equal(c.harness.concurrency, 2)
  assert.equal(c.harness.maxRounds, 3)
  assert.equal(c.sse.keepaliveMs, 15_000)
  assert.equal(c.log.level, 'info')
  assert.equal(c.workspaceDir, './.agent-runs')
})

test('环境变量覆盖：数字/字符串均生效', () => {
  const { config: c } = loadEnv({
    ...BASE,
    PORT: '8088',
    HOST: '0.0.0.0',
    QWEN_BASE_URL: 'http://llm.internal/v1',
    MODEL_NAME: 'qwen-max',
    MODEL_MAX_TOKENS: '8192',
    HARNESS_TIMEOUT_MS: '30000',
    HARNESS_CONCURRENCY: '4',
    SSE_KEEPALIVE_MS: '10000',
    LOG_LEVEL: 'debug',
    WORKSPACE_DIR: '/tmp/agent-runs',
  })
  assert.equal(c.server.port, 8088)
  assert.equal(c.server.host, '0.0.0.0')
  assert.equal(c.qwen.baseURL, 'http://llm.internal/v1')
  assert.equal(c.model.name, 'qwen-max')
  assert.equal(c.model.maxTokens, 8192)
  assert.equal(c.harness.timeoutMs, 30_000)
  assert.equal(c.harness.concurrency, 4)
  assert.equal(c.sse.keepaliveMs, 10_000)
  assert.equal(c.log.level, 'debug')
  assert.equal(c.workspaceDir, '/tmp/agent-runs')
})

test('必填缺失 → fail fast，抛 ConfigError 且带变量名', () => {
  assert.throws(() => loadEnv({}), (e) => e instanceof ConfigError && e.key === 'QWEN_API_KEY')
  assert.throws(
    () => loadEnv({ QWEN_API_KEY: 'k' }),
    (e) => e instanceof ConfigError && e.key === 'MODEL_NAME',
  )
})

test('非法值 → 抛 ConfigError，且带变量名与收到值', () => {
  const cases = [
    { env: { ...BASE, PORT: 'abc' }, key: 'PORT' },
    { env: { ...BASE, PORT: '0' }, key: 'PORT' },
    { env: { ...BASE, PORT: '70000' }, key: 'PORT' },
    { env: { ...BASE, MODEL_MAX_TOKENS: '-1' }, key: 'MODEL_MAX_TOKENS' },
    { env: { ...BASE, HARNESS_RETRIES: '1.5' }, key: 'HARNESS_RETRIES' },
    { env: { ...BASE, MODEL_TEMPERATURE: '3' }, key: 'MODEL_TEMPERATURE' },
    { env: { ...BASE, HARNESS_CONCURRENCY: '0' }, key: 'HARNESS_CONCURRENCY' },
    { env: { ...BASE, SSE_KEEPALIVE_MS: '100' }, key: 'SSE_KEEPALIVE_MS' },
    { env: { ...BASE, LOG_LEVEL: 'verbose' }, key: 'LOG_LEVEL' },
  ]
  for (const { env, key } of cases) {
    assert.throws(
      () => loadEnv(env),
      (e) => e instanceof ConfigError && e.code === 'CONFIG_INVALID' && e.key === key && e.message.includes(key),
      `期望 ${key} 抛 ConfigError`,
    )
  }
})

test('snapshot：可 JSON 序列化，apiKey 不出明文只留标记', () => {
  const { snapshot: snap } = loadEnv({ QWEN_API_KEY: 'sk-secret-123', MODEL_NAME: 'qwen-max', HARNESS_CONCURRENCY: '3' })
  const s = snap()
  const json = JSON.stringify(s)
  assert.ok(json.length > 0)
  assert.ok(!json.includes('sk-secret-123'), 'snapshot 不得包含 apiKey 明文')
  assert.equal(s.qwen.hasApiKey, true)
  assert.equal(s.model.name, 'qwen-max')
  assert.equal(s.harness.concurrency, 3)
  assert.notEqual(snap(), s) // 每次返回全新纯对象
})

test('必填项为空字符串 → 同样 fail fast（不等于未配置）', () => {
  assert.throws(
    () => loadEnv({ QWEN_API_KEY: '', MODEL_NAME: 'm' }),
    (e) => e instanceof ConfigError && e.key === 'QWEN_API_KEY',
  )
  assert.throws(
    () => loadEnv({ QWEN_API_KEY: 'k', MODEL_NAME: '   ' }),
    (e) => e instanceof ConfigError && e.key === 'MODEL_NAME',
  )
})

test('config 深度冻结：连带子孙对象都不可写', () => {
  assert.throws(() => { config.server.port = 1 }, TypeError)
  assert.throws(() => { config.model.maxTokens = 1 }, TypeError)
  assert.throws(() => { config.harness.concurrency = 1 }, TypeError)
})

test('模块级导出：来自真实环境的实例成对可用（读不到必填会在此前抛错）', () => {
  assert.equal(typeof config.server.port, 'number')
  assert.equal(typeof snapshot().qwen.hasApiKey, 'boolean')
})