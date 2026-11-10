// agent-server/src/state/runState.js —— 运行状态机与统一阶段包装
// 状态序列：INIT → PARSING → RULE_LOADING → PLANNING → EXECUTING → VERIFYING → DONE（成功）/ FAILED（失败）
// 每个编排阶段经 stage(run, name, fn) 统一包装：进入前检查 abort、发 progress(running/done)、记耗时。
// 私有注入：run._ctl（abort 控制器）、run._emit(event, data) —— 由 runReview 设置，stage 读取。

import { randomUUID } from 'node:crypto'
import { SdkError } from '../sdk/errors.js'

/** 编排阶段（INIT 为创建态，DONE/FAILED 为终态） */
export const STAGES = ['INIT', 'PARSING', 'RULE_LOADING', 'PLANNING', 'EXECUTING', 'VERIFYING', 'DONE', 'FAILED']
export const PHASE_STAGES = ['PARSING', 'RULE_LOADING', 'PLANNING', 'EXECUTING', 'VERIFYING']

/** abort 时阶段包装抛出的错误（与用户取消同语义） */
export function abortStageError() {
  return new SdkError('ABORT', '评审已中止，不再调度后续阶段', false)
}

/** 复跑参数白名单：只保留轻量字段，杜绝把文档内容/密钥写进状态 */
function sanitizeReq(req = {}) {
  return {
    runId: req.runId ?? null,
    docName: req.docName ?? null,
    docIds: Array.isArray(req.docIds) ? req.docIds : [],
    ruleSetId: req.ruleSetId ?? null,
    options: req.options ?? {},
  }
}

/**
 * 创建一次评审的运行状态。
 * @param {object} [req] 请求（runId/文档/规则集等；内容不进状态）
 * @returns {{
 *   runId:string, req:object, stage:string, stageStartedAt:number,
 *   stages:Record<string,{startedAt:number, durationMs:number}>, summary:object|null,
 *   coverage:object|null, metrics:object|null, error:object|null,
 *   setStage:(name:string, now?:number)=>void, finishStage:(name:string, now?:number)=>void,
 *   fail:(err:Error, now?:number)=>void, setDone:(payload:object, now?:number)=>void,
 *   totalDurationMs:()=>number, snapshot:()=>object,
 * }}
 */
export function createRunState(req = {}) {
  const startedAt = Date.now()
  const runId = req.runId ?? `run-${randomUUID().slice(0, 8)}`

  return {
    runId,
    req: sanitizeReq(req),
    stage: 'INIT',
    stageStartedAt: startedAt,
    stages: {}, // name -> { startedAt, durationMs }（按插入序）
    summary: null,
    coverage: null,
    metrics: null,
    error: null,

    /** 进入阶段：记录起始时间与状态名 */
    setStage(name, now = Date.now()) {
      this.stage = name
      this.stageStartedAt = now
    },
    /** 阶段结束：写回耗时（请求外再调用为空转，幂等） */
    finishStage(name, now = Date.now()) {
      const startedAt = this.stages[name]?.startedAt ?? this.stageStartedAt
      this.stages[name] = { startedAt, durationMs: now - startedAt }
    },
    /** 失败：终态 FAILED，保留错误信息与出错阶段（当前 stage） */
    fail(err, now = Date.now()) {
      this.error = {
        code: err?.code ?? err?.name ?? 'SERVER_ERROR',
        message: err?.message ?? String(err),
        retryable: err?.retryable ?? false,
        failedAt: this.stage, // 出错时仍在出错的编排阶段名
        failedAtMs: now,
      }
      this.stage = 'FAILED'
      this.stageStartedAt = now
    },
    /** 成功：终态 DONE，汇总结果供 done 事件 */
    setDone({ summary, coverage, metrics } = {}, now = Date.now()) {
      this.stage = 'DONE'
      this.summary = summary ?? null
      this.coverage = coverage ?? null
      this.metrics = metrics ?? null
      this.stageStartedAt = now
    },
    totalDurationMs() {
      return Date.now() - startedAt
    },
    /** 可 JSON 序列化快照（复跑参数/阶段耗时/状态），不含任何大对象 */
    snapshot() {
      return {
        runId: this.runId,
        req: this.req,
        stage: this.stage,
        stages: this.stages,
        summary: this.summary,
        coverage: this.coverage,
        metrics: this.metrics,
        error: this.error,
        durationMs: this.totalDurationMs(),
      }
    },
  }
}

/**
 * 统一阶段包装：进入前检查 abort → 发 progress(running) → 执行 fn → 记耗时 → 发 progress(done)。
 * fn 收到 (run, signal)，可自行协作检查取消。
 * @param {object} run createRunState 的返回值（需已注入 run._ctl / run._emit）*
 * @param {string} name 阶段名（PHASE_STAGES 之一）
 * @param {(run:object, signal:AbortSignal)=>Promise<unknown>|unknown} fn
 * @returns {Promise<unknown>} fn 的返回
 * @throws {SdkError} 已中止时抛 ABORT；fn 抛错原样上抛（不吞）
 */
export async function stage(run, name, fn) {
  if (run._ctl?.signal?.aborted) throw abortStageError()
  run.setStage(name)
  run._emit?.('progress', { runId: run.runId, stage: name, status: 'running' })

  const startedAt = Date.now()
  try {
    const out = await fn(run, run._ctl?.signal)
    run.finishStage(name, Date.now())
    run._emit?.('progress', { runId: run.runId, stage: name, status: 'done', durationMs: run.stages[name].durationMs })
    return out
  } catch (err) {
    run.finishStage(name, Date.now())
    throw err
  }
}