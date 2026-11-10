// src/metrics.js —— Token / 耗时统计（B1 Owner；队长路演要讲的数字来自这里）
// 口径与 docs/result.schema.json 的 metrics 字段一一对应。

const STAGES = ['parse', 'rules', 'plan', 'execute', 'verify', 'report']

export class Metrics {
  constructor() {
    this.startedAt = Date.now()
    this.tokenIn = 0
    this.tokenOut = 0
    this.llmCalls = 0
    this.deterministicCalls = 0
    this.issues = 0
    this._stages = new Map() // name -> { start, durationMs, tokenTotal }
  }

  begin(stage) {
    if (!STAGES.includes(stage)) throw new Error(`未知阶段: ${stage}`)
    this._stages.set(stage, { start: Date.now(), durationMs: 0, tokenTotal: 0 })
    return this
  }

  end(stage) {
    const s = this._stages.get(stage)
    if (!s) return this
    s.durationMs += Date.now() - s.start
    return this
  }

  addTokens({ in: tin = 0, out: tout = 0, stage } = {}) {
    this.tokenIn += tin
    this.tokenOut += tout
    this.llmCalls += 1
    const s = stage && this._stages.get(stage)
    if (s) s.tokenTotal += tin + tout
    return this
  }

  addDeterministic() {
    this.deterministicCalls += 1
    return this
  }

  /** 单条 rule_result 的实时快照（前端 metrics 事件） */
  snapshot() {
    return {
      tokenIn: this.tokenIn,
      tokenOut: this.tokenOut,
      tokenTotal: this.tokenIn + this.tokenOut,
      durationMs: Date.now() - this.startedAt,
      llmCalls: this.llmCalls,
      deterministicCalls: this.deterministicCalls,
      issues: this.issues,
    }
  }

  /** 最终写入 result.metrics 的结构 */
  finalize(coverage) {
    const stages = [...this._stages.entries()]
      .map(([name, s]) => ({ name, durationMs: s.durationMs, tokenTotal: s.tokenTotal }))
      .filter((s) => s.durationMs > 0 || s.tokenTotal > 0)
    return {
      ...this.snapshot(),
      stages,
      ruleCoverage: coverage?.rate ?? 0,
    }
  }
}
