// agent-server/src/harness.js —— 评审编排器（核心约束：只编排，不实现业务规则）
//
// runReview(req, sse, signal, deps?)：
//   - 状态机沿用 state/runState.js：INIT → PARSING → RULE_LOADING → PLANNING → EXECUTING → VERIFYING → DONE/FAILED
//   - 每阶段经 stage() 统一包装：进入前检查 abort、发 progress(running/done)、记耗时
//   - 业务层通过 deps（mock 时可注入）提供各阶段实现：缺函数则跳过该阶段
//   - 失败：发 error（含错误码/可重试/出错阶段），不发 done；成功：done 含 summary/coverage/metrics
//   - SSE 连接统一在 finally 关闭（成功/失败共用）；abort 后不再调度后续阶段

import { config } from './config/env.js'
import { createRunState, stage, PHASE_STAGES } from './state/runState.js'
import { createAbortController } from './state/abort.js'
import { normalizeSdkError } from './sdk/errors.js'
import { createMetrics } from './metrics/metrics.js'
import { invokeSkill } from './skills/registry.js'
import { SkillError } from './utils/timeout.js'
import { planRules } from './agents/planner.js'
import { executeTasks } from './agents/executor.js'

/**
 * 执行一次完整评审。
 * @param {object} req { runId?, docName?, ruleSetId?, options?, timeoutMs? }
 * @param {{send:(event:string, data:object)=>boolean, close:()=>void}} sse createSSE() 的返回值
 * @param {AbortSignal} [signal] 取消信号
 * @param {object} [deps] 各阶段实现（可注入 mock）：
 *   { parse?(run, signal), loadRules?, plan?, execute?(run, signal), verify? }
 *   execute 可返回 { events:[{event:'message'|'result', data}], warnings?, tokenUsage? }
 *   任意阶段抛错 → 归一化后发 error，不发 done。
 * @returns {Promise<{ok:boolean, runId:string, aborted:boolean, summary/coverage/metrics?(成功),
 *   error?:{code,message,retryable,stage}}>} 可 JSON 序列化
 */
export async function runReview(req, sse, signal, deps = {}) {
  const run = createRunState(req)
  const maxRounds = req?.maxRounds ?? config.harness.maxRounds // 全局 MAX_ROUNDS（复跑参数/指标记录）
  const ctl = createAbortController({ signal, timeoutMs: req?.timeoutMs ?? config.harness.timeoutMs })

  // stage() 包装所需注入（见 state/runState.js 内说明）
  run._ctl = ctl
  run._emit = (event, data) => sse.send(event, data)

  run._emit('run_started', { runId: run.runId, stages: PHASE_STAGES })

  // 指标聚合（检查契约：tokens/stages/rules/elapsedMs 等，见 metrics/metrics.js）
  const metrics = createMetrics()
  const runStage = async (name, fn) => {
    const out = await stage(run, name, fn)
    metrics.addStage(name, run.stages[name]?.durationMs ?? 0)
    return out
  }

  try {
    let blockIndex = null // parsed.documents[].blocks 重建（供检索/规则加载上下文）
    let ruleList = [] // registry loadRules 产出的规则数组（阶段 2 EXECUTING 消费）

    const parsed = await runStage('PARSING', async () => {
      if (deps.parse) return deps.parse(run, ctl.signal)
      const docs = req?.documents ?? []
      if (docs.length === 0) return null // 无文档：解析阶段空跑（与"缺阶段函数跳过"同语义）
      const out = await invokeSkill('parseDocument', { documents: docs, options: req?.options ?? {} }, { run, signal: ctl.signal })
      if (!out?.ok) {
        // 单文档解析失败 → documents[i].reason（格式 "CODE：message"，如 UNSUPPORTED_FORMAT：…）；
        // 调度/输入异常 → out.error。取原码透传，不统一成 PARSE_FAILED。
        const failed = (out?.documents ?? []).find((d) => d?.ok === false)
        const reason = typeof failed?.reason === 'string' ? failed.reason : null
        const code = reason?.split('：')[0] || out?.error?.code || 'PARSE_FAILED'
        const message = reason || out?.error?.message || '解析技能返回失败'
        throw new SkillError(code, message, out?.error?.detail)
      }
      blockIndex = new Map()
      for (const doc of out.documents ?? []) {
        for (const b of doc.blocks ?? []) blockIndex.set(b.blockId, { ...b, docId: b.docId ?? doc.docId, docName: b.docName ?? doc.docName })
      }
      return out
    })

    const loaded = await runStage('RULE_LOADING', async () => {
      if (deps.loadRules) return deps.loadRules(run, ctl.signal)
      const list = await invokeSkill('loadRules', { ruleManifest: req?.ruleManifest ?? [], ruleDocBlocks: blockIndex }, { run, signal: ctl.signal })
      ruleList = list
      return { rules: list, warnings: [] }
    })

    const plan = await runStage('PLANNING', () => {
      if (deps.plan) return deps.plan(run, ctl.signal)
      return planRules(ruleList) // 默认代码规划（LLM 规划默认关闭）
    })
    const exec = await runStage('EXECUTING', () => {
      if (deps.execute) return deps.execute(run, ctl.signal)
      return executeTasks({
        tasks: plan?.tasks ?? [],
        blockIndex,
        stepTimeoutMs: req?.options?.stepTimeoutMs ?? 30000, // 单步超时（含 invokeSkill），默认 30s
        concurrency: req?.options?.concurrency, // undefined → executor 默认 config.harness.concurrency
        signal: ctl.signal,
        sse,
      })
    })
    const verify = await runStage('VERIFYING', async () => {
      if (deps.verify) return deps.verify(run, ctl.signal)
      const coverage = await invokeSkill('verifyCoverage', {
        results: exec?.results ?? [],
        matrix: exec?.matrix ?? {},
        blockIndex,
      }, { run, signal: ctl.signal })
      return { summary: null, coverage } // done.coverage = { total, done, review, failed, details }（空规则 total=0 非 null）
    })

    // 业务层产出的中间事件与告警：只转发，不加工
    for (const evt of exec?.events ?? []) run._emit(evt.event, evt.data)
    for (const w of loaded?.warnings ?? rules?.warnings ?? exec?.warnings ?? []) run._emit('warning', w)

    // 指标：规则结果与 token 使用量
    for (const r of exec?.results ?? []) metrics.addRuleResult(r.status)
    if (exec?.tokenUsage) {
      metrics.addTokens({
        prompt: exec.tokenUsage.input ?? 0,
        completion: exec.tokenUsage.output ?? 0,
        estimated: exec.tokenUsage.estimated,
      })
    }

    const metricsPayload = { ...metrics.snapshot(), runId: run.runId, maxRounds }
    run.setDone({
      summary: verify?.summary ?? exec?.summary ?? null,
      coverage: verify?.coverage ?? exec?.coverage ?? null,
      metrics: metricsPayload,
    })
    run._emit('metrics', metricsPayload)
    run._emit('done', { runId: run.runId, summary: run.summary, coverage: run.coverage, metrics: metricsPayload })
    return { ok: true, runId: run.runId, summary: run.summary, coverage: run.coverage, metrics: metricsPayload }
  } catch (err) {
    const aborted = ctl.signal.aborted
    // 技能错误（SkillError）透传原码（UNSUPPORTED_FORMAT/READ_FAILED/OCR_REQUIRED…），不统一成 SERVER_ERROR/INTERNAL
    const se = err instanceof SkillError ? err : normalizeSdkError(err)
    const code = aborted && !ctl.timedOut() ? 'ABORTED' : se.code // 手动/外部中止 → ABORTED（对外约定）；超时保持原码
    run.fail({ ...se, code })
    run._emit('error', {
      runId: run.runId, code, message: se.message,
      retryable: se.retryable, stage: run.error.failedAt, aborted,
    })
    return { ok: false, runId: run.runId, aborted, error: { code, message: se.message, retryable: se.retryable, stage: run.error.failedAt } }
  } finally {
    ctl.cleanup()
    sse.close() // 唯一关闭点：成功/失败共用，保证连接有终态
  }
}

/** 指标汇总：MAX_ROUNDS + 阶段耗时 + token 用量（业务层未报则占位） */
function buildMetrics(run, exec, maxRounds) {
  return {
    runId: run.runId,
    maxRounds,
    durationMs: run.totalDurationMs(),
    stages: { ...run.stages },
    tokenUsage: exec?.tokenUsage ?? { input: 0, output: 0, total: 0, estimated: true },
  }
}