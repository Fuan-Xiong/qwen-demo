// agent-server/src/agents/verifier.js —— 验证器（覆盖度收尾）
// 调 verifyCoverage skill（deps 注入，缺省用默认统计实现）；矩阵中 review 状态 → warning 事件；
// 返回最终 results（含每条规则输出）+ coverage（覆盖度统计）。

/**
 * 验证收尾。
 * @param {object} opts
 * @param {Array<object>} opts.results executor 产出的逐规则结果
 * @param {Record<string,{status:string}>} opts.matrix 规则矩阵
 * @param {{send:(event:string, data:object)=>boolean}} opts.sse
 * @param {string} [opts.runId]
 * @param {object} [opts.deps]
 *   verifyCoverage?({results, matrix}) -> coverage   外部 skill 实现（可注入 mock/真实 B2 技能）
 * @returns {Promise<{results:Array<object>, coverage:object, matrix:object}>}
 */
export async function verifyCoverage({ results, matrix, sse, runId, deps = {} } = {}) {
  const skill = deps.verifyCoverage ?? defaultVerifyCoverage
  const coverage = await skill({ results, matrix })

  // review（待人工复核）→ warning 事件，不算失败
  for (const r of results) {
    if (r.status === 'review') {
      sse.send('warning', {
        code: 'REVIEW_REQUIRED',
        runId,
        ruleId: r.ruleId,
        message: `规则 ${r.ruleId} 需人工复核：${r.reason ?? '比对结果不确定'}`,
      })
    }
  }
  return { results, coverage, matrix }
}

/**
 * 默认覆盖度统计（未注入 verifyCoverage skill 时的兜底实现）。
 * @param {{results?:Array<object>, matrix?:Record<string,{status:string}>}} [input]
 * @returns {{total:number, done:number, review:number, failed:number, pass:number, fail:number, coverageRate:number}}
 */
export function defaultVerifyCoverage({ results, matrix } = {}) {
  const entries = Object.entries(matrix ?? {})
  const byStatus = {}
  for (const [, cell] of entries) {
    const status = cell.status ?? 'pending'
    byStatus[status] = (byStatus[status] ?? 0) + 1
  }
  const byResult = { pass: 0, fail: 0 }
  for (const r of results ?? []) {
    if (r.status === 'pass') byResult.pass += 1
    else if (r.status === 'fail') byResult.fail += 1
  }
  const total = entries.length
  return {
    total,
    done: byStatus.done ?? 0,
    review: byStatus.review ?? 0,
    failed: byStatus.failed ?? 0,
    pass: byResult.pass,
    fail: byResult.fail,
    coverageRate: total > 0 ? (byStatus.done ?? 0) / total : 0,
  }
}