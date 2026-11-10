// agent-server/src/agents/executor.js —— 执行器（并发 worker 队列 + 规则矩阵）
//
// 核心约束：
// - concurrency 可配（默认 config.harness.concurrency，测试可显式注入）；
// - 每条 task 依次调 retrieveContext →（deterministic|semantic 按 checkType 分流）→ locateEvidence
//   → 更新矩阵 → sse.send("result")；
// - 单规则超时（TimeoutError）→ 矩阵标 review；其余异常 → 标 failed；都不终止整体，其他任务继续；
// - 所有业务能力（检索/比对/定位/验证）由 deps 注入，本模块只编排。

import { config } from '../config/env.js'
import { withTimeout } from '../utils/timeout.js' // 共享超时：超时抛 SkillError("TIMEOUT")
import { invokeSkill } from '../skills/registry.js'

const RESULT_STATUSES = ['pass', 'fail', 'review', 'not_applicable']

/**
 * 执行规划任务。
 * @param {object} opts
 * @param {Array<object>} opts.tasks planner 产出的任务（含 ruleId/checkType/severity/keywords…）
 * @param {number} [opts.concurrency] 并发上限，默认 config.harness.concurrency
 * @param {number} [opts.taskTimeoutMs] 单个步骤超时（ms），默认 config.harness.timeoutMs
 * @param {number} [opts.maxAttempts] 单规则尝试上限，默认 config.harness.maxRounds（MAX_ROUNDS）
 * @param {AbortSignal} [opts.signal]
 * @param {{send:(event:string, data:object)=>boolean}} opts.sse
 * @param {object} [opts.deps]
 *   retrieveContext?(task, signal) -> ctx            （检索候选上下文）
 *   compareDeterministic?(task, ctx, signal) -> Result
 *   compareSemantic?(task, ctx, signal) -> Result     （可返回 review）
 *   locateEvidence?(task, result, ctx, signal) -> Evidence[]
 * @returns {Promise<{results:Array<object>, matrix:Record<string,object>}>}
 *   matrix[ruleId] = { ruleId, status, attempts, result, reason }
 */
export async function executeTasks({
  tasks, concurrency = config.harness.concurrency, taskTimeoutMs = config.harness.timeoutMs,
  stepTimeoutMs, maxAttempts = config.harness.maxRounds, signal, sse, deps = {}, blockIndex,
} = {}) {
  const stepMs = stepTimeoutMs ?? taskTimeoutMs ?? 30000 // invokeSkill 每步超时：请求 stepTimeoutMs 优先（默认 30s）
  // 缺省走 registry 技能（可注入 mock 覆盖）：retrieveContext / runDeterministic 经 invokeSkill 调用
  const retrieveContext = deps.retrieveContext ?? ((task) => invokeSkill('retrieveContext', { task, blockIndex }, { task, signal }))
  const compareDeterministic = deps.compareDeterministic ?? ((task, ctx) => invokeSkill('runDeterministic', { task, ctx }, { task, ctx, signal }))
  const compareSemantic = deps.compareSemantic ?? (async () => ({ status: 'review', reason: '未注入 semantic 比对器' }))
  const locateEvidence = deps.locateEvidence ?? (async () => [])

  /** 规则矩阵：start 阶段即铺好 pending 单元格 */
  const matrix = {}
  for (const task of tasks) {
    matrix[task.ruleId] = { ruleId: task.ruleId, status: 'pending', attempts: 0, result: null, reason: null }
  }

  /** 单条规则执行（失败/超时只在单元格内体现，不外抛） */
  async function runTask(task) {
    const cell = matrix[task.ruleId]
    cell.status = 'running'
    cell.attempts += 1

    const fail = (status, code, message) => {
      cell.status = status // review（超时）| failed（异常/超限）
      cell.reason = message
      const result = { ruleId: task.ruleId, ruleName: task.ruleName, status, evidence: [], confidence: 0, reason: message }
      cell.result = result
      sse.send('result', result)
      sse.send('warning', { code, ruleId: task.ruleId, message })
      return result
    }

    // 单规则尝试次数上限（MAX_ROUNDS）：超限不再执行，直接 failed
    if (cell.attempts > maxAttempts) {
      return fail('failed', 'MAX_ATTEMPTS', `规则 ${task.ruleId} 达到最大尝试次数（${maxAttempts}）`)
    }

    try {
      const ctx = await withTimeout(retrieveContext(task, signal), stepMs, `${task.ruleId}:检索`)
      const evaluator = task.checkType === 'semantic' || task.checkType === 'cross_doc' ? compareSemantic : compareDeterministic
      const raw = await withTimeout(evaluator(task, ctx, signal), stepMs, `${task.ruleId}:比对`)
      const result = normalizeResult(raw, task)
      const evidence = await withTimeout(locateEvidence(task, result, ctx, signal), stepMs, `${task.ruleId}:定位证据`)

      result.evidence = Array.isArray(evidence) ? evidence : []
      cell.status = 'done'
      cell.result = result
      sse.send('result', result)
      if (result.status === 'review') sse.send('warning', { code: 'REVIEW_RESULT', ruleId: task.ruleId, message: `规则 ${task.ruleId} 比对结果需复核` })
      return result
    } catch (err) {
      // 共享 withTimeout 抛 SkillError("TIMEOUT")；兼容 code= TIMEOUT（SdkError 同码）
      const timedOut = err?.code === 'TIMEOUT'
      return fail(timedOut ? 'review' : 'failed', timedOut ? 'RULE_TIMEOUT' : 'RULE_FAILED', timedOut ? '执行超时' : `${err?.code ?? err?.name}: ${err?.message}`)
    }
  }

  /** 并发 worker 池：按序取任务，abort 后不再调度剩余任务 */
  const queue = [...tasks]
  const results = []
  const active = { count: 0 }
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, async () => {
    while (next < queue.length) {
      if (signal?.aborted) break
      const task = queue[next]
      next += 1
      active.count += 1
      try {
        results.push(await runTask(task))
      } finally {
        active.count -= 1
      }
    }
  })
  await Promise.all(workers)
  return { results, matrix }
}

/** 归一化比对结果（缺失/非法 status → review，不吞错但保证统一结构） */
function normalizeResult(raw, task) {
  if (!raw || typeof raw !== 'object') return { status: 'review', reason: '比对器未返回结果', confidence: 0 }
  const status = RESULT_STATUSES.includes(raw.status) ? raw.status : 'review'
  return {
    ruleId: task.ruleId,
    ruleName: task.ruleName ?? raw.ruleName,
    status,
    severity: task.severity,
    suggestion: raw.suggestion,
    confidence: Number.isFinite(raw.confidence) ? raw.confidence : null,
    reason: raw.reason,
    evidence: [],
  }
}