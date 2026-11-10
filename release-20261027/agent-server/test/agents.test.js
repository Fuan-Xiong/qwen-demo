// agent-server/test/agents.test.js —— agents 层测试（node:test + node:assert/strict）
// 覆盖：planner 按 checkType 分组规划；executor 3 规则 2 并发（result 条数/矩阵状态/超时→review）；
//       单规则失败不终止整体；verifier 覆盖度与 review→warning。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

// executor 读 config.harness.concurrency：先注入必填项再动态加载
process.env.QWEN_API_KEY = process.env.QWEN_API_KEY ?? 'test-key'
process.env.MODEL_NAME = process.env.MODEL_NAME ?? 'test-model'
const { planRules } = await import('../src/agents/planner.js')
const { executeTasks } = await import('../src/agents/executor.js')
const { verifyCoverage, defaultVerifyCoverage } = await import('../src/agents/verifier.js')

function fakeSse() {
  const events = []
  return { events, send(name, data) { events.push({ name, data }); return true }, close() {} }
}

const RULES = [
  { ruleId: 'R1', ruleName: '报价有效期', checkType: 'deterministic', severity: 'high', priority: 'P0' },
  { ruleId: 'R2', ruleName: '付款比例', checkType: 'deterministic', severity: 'medium', priority: 'P1' },
  { ruleId: 'R3', ruleName: '付款方式语义', checkType: 'semantic', severity: 'medium', priority: 'P2' },
]

/** mock 业务能力（executor 的 deps） */
function makeDeps(overrides = {}) {
  const state = { active: 0, maxActive: 0 }
  return {
    state,
    retrieveContext: async (task) => { state.active += 1; state.maxActive = Math.max(state.maxActive, state.active); await sleep(5); state.active -= 1; return { chunks: [`${task.ruleId} 检索结果`] } },
    compareDeterministic: async (task) => ({ status: task.ruleId === 'R1' ? 'pass' : 'fail', confidence: 0.9, suggestion: task.ruleId === 'R2' ? '预付款比例不得高于 30%' : undefined }),
    compareSemantic: async (task) => { await sleep(task.ruleId === 'R3' ? 200 : 10); return { status: 'pass', confidence: 0.7 } },
    locateEvidence: async (task) => [{ docId: 'd1', blockId: `b-${task.ruleId}`, charStart: 0, charEnd: 4, text: task.ruleId }],
    ...overrides,
  }
}

test('planner：按 checkType 分组，每条规则一个 task，order 只含非空组', () => {
  const { tasks, groups, order } = planRules(RULES)
  assert.equal(tasks.length, 3)
  assert.deepEqual(order, ['deterministic', 'semantic'])
  assert.equal(groups.deterministic.length, 2)
  assert.equal(groups.semantic.length, 1)
  assert.equal(groups.cross_doc.length, 0)
  assert.deepEqual(groups.deterministic.map((t) => t.ruleId), ['R1', 'R2'])
  assert.equal(tasks[0].taskId, 't1')
  assert.equal(tasks[2].checkType, 'semantic')
})

test('executor：3 规则 2 并发 → 3 条 result、矩阵 done/done/review、超时规则 review', async () => {
  const sse = fakeSse()
  const deps = makeDeps()
  const { results, matrix } = await executeTasks({
    tasks: planRules(RULES).tasks,
    concurrency: 2,
    taskTimeoutMs: 40, // R3 比对需 200ms → 超时
    sse,
    deps,
  })

  // result 条数 = 任务条数
  assert.equal(results.length, 3)
  assert.equal(sse.events.filter((e) => e.name === 'result').length, 3)

  // 矩阵状态：R1/R2 done，R3 review（超时）
  assert.equal(matrix.R1.status, 'done')
  assert.equal(matrix.R2.status, 'done')
  assert.equal(matrix.R3.status, 'review')
  assert.equal(matrix.R3.result.status, 'review')
  assert.match(matrix.R3.reason, /超时/)

  // R3 超时 → RULE_TIMEOUT warning
  assert.ok(sse.events.some((e) => e.name === 'warning' && e.data.code === 'RULE_TIMEOUT' && e.data.ruleId === 'R3'))

  // 并发上限：峰值 ≤ 2 且 > 1（确有并发）
  assert.ok(deps.state.maxActive <= 2, `并发峰值 ${deps.state.maxActive} 不得超限`)
  assert.ok(deps.state.maxActive > 1, '并发峰值应大于 1（验证并发生效）')

  // result 事件与返回值一致（R1 pass / R2 fail）
  const r1 = results.find((r) => r.ruleId === 'R1')
  assert.equal(r1.status, 'pass')
  assert.equal(r1.evidence.length, 1)
  const r2 = results.find((r) => r.ruleId === 'R2')
  assert.equal(r2.status, 'fail')
})

test('executor：单规则异常标 failed，不终止其他规则', async () => {
  const sse = fakeSse()
  const deps = makeDeps({
    compareDeterministic: async (task) => {
      if (task.ruleId === 'R2') throw new Error('确定性比对崩溃')
      return { status: 'pass', confidence: 0.9 }
    },
  })
  const { results, matrix } = await executeTasks({
    tasks: planRules(RULES).tasks,
    concurrency: 2,
    taskTimeoutMs: 2_000,
    sse,
    deps,
  })

  assert.equal(results.length, 3, '个别规则失败不影响整体条数')
  assert.equal(matrix.R1.status, 'done')
  assert.equal(matrix.R2.status, 'failed')
  assert.match(matrix.R2.reason, /确定性比对崩溃/)
  assert.equal(matrix.R3.status, 'done')
  assert.ok(sse.events.some((e) => e.name === 'warning' && e.data.code === 'RULE_FAILED' && e.data.ruleId === 'R2'))
})

test('verifier：review → REVIEW_REQUIRED warning；覆盖度统计正确', async () => {
  const sse = fakeSse()
  // 手工铺一个"1 done + 1 review"的最小矩阵与结果
  const results = [
    { ruleId: 'R1', status: 'pass' },
    { ruleId: 'R3', status: 'review', reason: '比对结果不确定' },
  ]
  const matrix = { R1: { status: 'done' }, R3: { status: 'review' } }
  const out = await verifyCoverage({ results, matrix, sse, runId: 'run-x' })

  assert.equal(out.coverage.total, 2)
  assert.equal(out.coverage.done, 1)
  assert.equal(out.coverage.review, 1)
  assert.equal(out.coverage.coverageRate, 0.5)
  assert.ok(sse.events.some((e) => e.name === 'warning' && e.data.code === 'REVIEW_REQUIRED' && e.data.ruleId === 'R3'))
  assert.equal(sse.events.filter((e) => e.name === 'warning').length, 1)
  assert.equal(out.results.length, 2)
})

test('verifier：可注入外部 verifyCoverage skill', async () => {
  const sse = fakeSse()
  const out = await verifyCoverage({
    results: [], matrix: {},
    sse,
    deps: { verifyCoverage: async () => ({ done: 3, review: 1, coverageRate: 0.75 }) },
  })
  assert.deepEqual(out.coverage, { done: 3, review: 1, coverageRate: 0.75 })
})

test('defaultVerifyCoverage：空矩阵 → 全 0 不除零', () => {
  const c = defaultVerifyCoverage({ results: [], matrix: {} })
  assert.equal(c.total, 0)
  assert.equal(c.coverageRate, 0)
})