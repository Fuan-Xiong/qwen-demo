// agent-server/test/timeout.test.js —— utils 层测试（node:test + node:assert/strict）
// 覆盖：withTimeout 超时抛 SkillError("TIMEOUT")；callWithRetry 不可重试不重试；
//       可重试次数正确（退避重试 + 耗尽抛最后一次）；MAX_ROUNDS（maxAttempts）封顶生效。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { withTimeout, SkillError } from '../src/utils/timeout.js'
import { callWithRetry, isRetryable } from '../src/utils/retry.js'

const retryable = (message = '可重试错误') => Object.assign(new Error(message), { retryable: true })
const hard = (message = '不可重试错误') => Object.assign(new Error(message), { retryable: false })

// ── withTimeout ─────────────────────────────────────────

test('withTimeout：超时抛 SkillError("TIMEOUT")，消息含 label 与时长', async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 20, '测试调用'),
    (e) => e instanceof SkillError && e.code === 'TIMEOUT' && e.message.includes('测试调用') && e.message.includes('20'),
  )
})

test('withTimeout：正常 resolve / reject 原样透传，ms<=0 不启用超时', async () => {
  assert.equal(await withTimeout(Promise.resolve('ok'), 50), 'ok')
  await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 50), /boom/)
  // ms<=0：不设超时，挂起函数也能正常返回
  assert.equal(await withTimeout(Promise.resolve('ok'), 0), 'ok')
})

// ── callWithRetry：不可重试不重试 ───────────────────────

test('callWithRetry：非 retryable 错误只调用一次，不重试', async () => {
  const onRetry = []
  let calls = 0
  await assert.rejects(
    callWithRetry(async () => { calls += 1; throw hard('鉴权失败') }, { retries: 3, baseDelayMs: 1, onRetry: (i) => onRetry.push(i) }),
    /鉴权失败/,
  )
  assert.equal(calls, 1)
  assert.equal(onRetry.length, 0, '不可重试不得触发退避')
})

test('isRetryable：仅 retryable===true 为真', () => {
  assert.equal(isRetryable(retryable()), true)
  assert.equal(isRetryable(hard()), false)
  assert.equal(isRetryable(new Error('x')), false)
})

// ── callWithRetry：可重试次数正确 ───────────────────────

test('callWithRetry：前两次可重试失败、第三次成功 → 共调用 3 次并返回结果', async () => {
  let calls = 0
  const onRetry = []
  const out = await callWithRetry(
    async () => {
      calls += 1
      if (calls < 3) throw retryable(`第 ${calls} 次失败`)
      return 'done'
    },
    { retries: 2, baseDelayMs: 1, onRetry: (i) => onRetry.push(i) },
  )
  assert.equal(out, 'done')
  assert.equal(calls, 3)
  assert.equal(onRetry.length, 2, '前两次失败各触发一次退避')
})

test('callWithRetry：重试耗尽后抛最后一次错误（不吞错）', async () => {
  let calls = 0
  const lastErr = await callWithRetry(
    async () => { calls += 1; throw retryable(`第 ${calls} 次`) },
    { retries: 2, baseDelayMs: 1 },
  ).catch((e) => e)
  assert.equal(calls, 3, 'retries=2 → 初始 1 次 + 重试 2 次 = 3 次调用')
  assert.match(lastErr.message, /第 3 次/)
})

// ── callWithRetry：MAX_ROUNDS（maxAttempts）封顶 ────────

test('callWithRetry：maxAttempts（全局 MAX_ROUNDS）封顶——即使 retries 更大也只到上限', async () => {
  let calls = 0
  await assert.rejects(
    callWithRetry(
      async () => { calls += 1; throw retryable('一直可重试') },
      { retries: 10, maxAttempts: 3, baseDelayMs: 1 }, // MAX_ROUNDS=3，retries 再大也无效
    ),
    /一直可重试/,
  )
  assert.equal(calls, 3, 'maxAttempts=3 → 总调用恰 3 次，不得因 retries=10 跑到 11 次')
})

test('callWithRetry：maxAttempts 默认不封顶（只受 retries 约束）', async () => {
  let calls = 0
  await assert.rejects(
    callWithRetry(async () => { calls += 1; throw retryable('x') }, { retries: 1, baseDelayMs: 1 }),
    /x/,
  )
  assert.equal(calls, 2, '未传 maxAttempts → 按 retries=1 调用 2 次')
})