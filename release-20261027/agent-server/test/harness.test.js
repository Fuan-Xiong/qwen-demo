// agent-server/test/harness.test.js —— 评审编排器测试（node:test + node:assert/strict）
// 覆盖：正常跑完（阶段顺序 + done 含 summary/coverage/metrics + 事件集）、
//       某阶段抛错（error 事件、不发 done）、abort 后不再调度。

import { test } from 'node:test'
import assert from 'node:assert/strict'

// env.js 顶层 fail fast：先注入必填项再动态加载
process.env.QWEN_API_KEY = process.env.QWEN_API_KEY ?? 'test-key'
process.env.MODEL_NAME = process.env.MODEL_NAME ?? 'test-model'
const { runReview } = await import('../src/harness.js')
const { PHASE_STAGES } = await import('../src/state/runState.js')
const { SdkError } = await import('../src/sdk/errors.js')

/** 最小 SSE mock：记录事件序列，close 幂等 */
function fakeSse() {
  const events = []
  let closed = false
  return {
    events,
    get closed() { return closed },
    send(name, data) { if (!closed) events.push({ name, data }); return !closed },
    close() { closed = true },
  }
}

/** mock skill registry：记录阶段调用顺序，默认全阶段正常 */
function makeDeps(overrides = {}) {
  const calls = []
  return {
    calls,
    parse: async () => { calls.push('PARSING'); return { docName: 'a.docx', blocks: [] } },
    loadRules: async () => { calls.push('RULE_LOADING'); return { rules: ['R1'], warnings: [{ code: 'demo', message: '规则加载告警' }] } },
    plan: async () => { calls.push('PLANNING'); return { plan: [{ ruleId: 'R1' }] } },
    execute: async () => {
      calls.push('EXECUTING')
      return {
        events: [
          { event: 'message', data: { role: 'assistant', content: '模型中间消息' } },
          { event: 'result', data: { ruleId: 'R1', status: 'pass', evidence: [] } },
        ],
        tokenUsage: { input: 100, output: 50, total: 150, estimated: false },
      }
    },
    verify: async () => { calls.push('VERIFYING'); return { summary: { total: 1, pass: 1, fail: 0 }, coverage: { R1: 'pass' } } },
    ...overrides,
  }
}

test('正常跑完：阶段顺序正确、首事件 run_started、末事件 done 含 summary/coverage/metrics', async () => {
  const sse = fakeSse()
  const deps = makeDeps()
  const res = await runReview({ runId: 'run-1', docName: 'a.docx' }, sse, undefined, deps)

  assert.equal(res.ok, true)
  assert.equal(res.runId, 'run-1')
  assert.deepEqual(deps.calls, PHASE_STAGES)
  assert.equal(sse.events[0].name, 'run_started')
  assert.equal(sse.events[0].data.stages.join(','), PHASE_STAGES.join(','))
  const last = sse.events.at(-1)
  assert.equal(last.name, 'done')
  assert.ok(last.data.summary && last.data.summary.pass === 1)
  assert.deepEqual(last.data.coverage, { R1: 'pass' })
  assert.ok(last.data.metrics.runId === 'run-1' && last.data.metrics.stages.PARSING >= 0)
  // done 里的 metrics 与指标来源一致（检查 4 契约：tokens/elapsedMs/stages/rules）
  assert.deepEqual(last.data.metrics.tokens, { prompt: 100, completion: 50, total: 150, estimated: false })
  assert.ok('elapsedMs' in last.data.metrics && 'rules' in last.data.metrics)
  // SSE 在 finally 关闭
  assert.equal(sse.closed, true)
})

test('正常跑完：事件集覆盖协议事件（run_started/progress/message/result/metrics/warning/done），不发 error', async () => {
  const sse = fakeSse()
  await runReview({ runId: 'run-1' }, sse, undefined, makeDeps())

  const names = new Set(sse.events.map((e) => e.name))
  for (const n of ['run_started', 'progress', 'message', 'result', 'metrics', 'warning', 'done']) {
    assert.ok(names.has(n), `缺少事件 ${n}`)
  }
  assert.ok(!names.has('error'), '正常跑完不得发 error')

  // progress：每个编排阶段有 running 与 done 两种状态
  const progress = sse.events.filter((e) => e.name === 'progress')
  assert.equal(progress.length, PHASE_STAGES.length * 2)
  for (const stageName of PHASE_STAGES) {
    assert.ok(progress.some((p) => p.data.stage === stageName && p.data.status === 'running'), `${stageName} running`)
    assert.ok(progress.some((p) => p.data.stage === stageName && p.data.status === 'done'), `${stageName} done`)
  }
})

test('某阶段抛错 → 发 error（含出错阶段与可重试标记），不发 done，返回 ok:false', async () => {
  const sse = fakeSse()
  const deps = makeDeps({
    execute: async () => { throw new SdkError('RATE_LIMIT', '模型限流', true) },
  })
  const res = await runReview({ runId: 'run-2' }, sse, undefined, deps)

  assert.equal(res.ok, false)
  assert.deepEqual(res.error, { code: 'RATE_LIMIT', message: '模型限流', retryable: true, stage: 'EXECUTING' })
  assert.ok(!sse.events.some((e) => e.name === 'done'), '失败不得发 done')
  const errEvt = sse.events.find((e) => e.name === 'error')
  assert.ok(errEvt)
  assert.equal(errEvt.data.stage, 'EXECUTING')
  assert.equal(errEvt.data.retryable, true)
  assert.equal(sse.closed, true)
})

test('abort 后不再调度后续阶段（VERIFYING 未执行，发 error(ABORTED) 不发 done）', async () => {
  const sse = fakeSse()
  let verifyRan = 0
  const deps = makeDeps({
    execute: (_run, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    }),
    verify: async () => { verifyRan += 1; return {} },
  })
  const ctrl = new AbortController()
  const p = runReview({ runId: 'run-3' }, sse, ctrl.signal, deps)
  setTimeout(() => ctrl.abort(), 20)
  const res = await p

  assert.equal(res.aborted, true)
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'ABORTED')
  assert.equal(verifyRan, 0, 'abort 后 VERIFYING 不得被调度')
  assert.ok(!sse.events.some((e) => e.name === 'done'))
  assert.ok(!sse.events.some((e) => e.name === 'progress' && e.data.stage === 'VERIFYING'))
  const errEvt = sse.events.find((e) => e.name === 'error')
  assert.equal(errEvt.data.aborted, true)
  assert.equal(errEvt.data.code, 'ABORTED')
})

test('缺阶段函数 → 跳过该阶段仍正常 done（编排不强制实现）', async () => {
  const sse = fakeSse()
  const deps = makeDeps({})
  delete deps.verify
  delete deps.parse
  delete deps.plan
  const res = await runReview({ runId: 'run-4' }, sse, undefined, deps)
  assert.equal(res.ok, true)
  assert.deepEqual(deps.calls, ['RULE_LOADING', 'EXECUTING'])
  assert.equal(sse.events.at(-1).name, 'done')
})

test('无 runId → 自动生成 run-xxxx，run_started 携带同一 id', async () => {
  const sse = fakeSse()
  const res = await runReview({ docName: 'a.docx' }, sse, undefined, makeDeps())
  assert.match(res.runId, /^run-[0-9a-f]{8}$/)
  assert.equal(sse.events[0].data.runId, res.runId)
})