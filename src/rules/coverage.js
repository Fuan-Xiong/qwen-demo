// src/rules/coverage.js —— 规则覆盖矩阵（B2 Owner，队长验收）
// 目的：让"漏查"显性化。跑完仍 pending 的规则 = 未覆盖，前端红字告警。

/**
 * @param {Array} rules   loadRules 结果
 * @param {Map<string, object>} results  ruleId -> compareRule 结果
 */
export function buildCoverage(rules, results) {
  const items = rules.map((r) => {
    const hit = results.get(r.ruleId)
    if (!hit) return { ruleId: r.ruleId, state: 'pending', verdict: undefined }
    const state = hit.verdict === 'review' || (hit.confidence ?? 1) < 0.7 ? 'review' : 'done'
    return { ruleId: r.ruleId, state, verdict: hit.verdict }
  })

  const count = (s) => items.filter((i) => i.state === s).length
  const done = count('done')
  const review = count('review')
  const pending = count('pending')
  const total = items.length

  return {
    total,
    done,
    review,
    pending,
    rate: total === 0 ? 0 : Number((done / total).toFixed(4)),
    uncoveredAlerts: items.filter((i) => i.state === 'pending').map((i) => i.ruleId),
    items,
  }
}
