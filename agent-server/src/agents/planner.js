// agent-server/src/agents/planner.js —— 规划器（默认代码规划；可选 LLM 规划，默认关闭）
// 按 checkType 分组（deterministic / semantic / cross_doc），每条规则一个 task。
// LLM 规划仅在 useLlmPlan=true 且注入 deps.llmPlan 时走；默认不启用（保持确定性）。

const CHECK_TYPES = ['deterministic', 'semantic', 'cross_doc']

/**
 * 规则 → 规划任务。
 * @param {Array<object>} rules 统一 Rule 结构（ruleId/ruleName/checkType/severity/priority/keywords…）
 * @param {{useLlmPlan?:boolean, deps?:{llmPlan?:(rules)=>unknown}}|undefined} [opts]
 * @returns {{tasks:Array<object>, groups:Record<string, object[]>, order:string[]}}
 *   tasks：每条规则一个 { taskId, idx, ruleId, ruleName, checkType, severity, priority, keywords, sourceClause }
 *   groups：按 checkType 分组的 task 列表；order：非空分组的有序数组
 */
export function planRules(rules = [], { useLlmPlan = false, deps = {} } = {}) {
  if (useLlmPlan && typeof deps.llmPlan === 'function') {
    // 可选 LLM 规划：默认关闭；若启用，deps.llmPlan 负责返回与代码规划同构的 plan
    return normalizePlan(deps.llmPlan(rules))
  }

  const groups = { deterministic: [], semantic: [], cross_doc: [] }
  const tasks = rules.map((rule, idx) => {
    const checkType = CHECK_TYPES.includes(rule.checkType) ? rule.checkType : 'deterministic'
    const task = {
      taskId: `t${idx + 1}`,
      idx,
      ruleId: rule.ruleId,
      ruleName: rule.ruleName ?? rule.ruleId,
      checkType,
      severity: rule.severity ?? 'medium',
      priority: rule.priority ?? 'P2',
      keywords: rule.keywords ?? [],
      sourceClause: rule.sourceClause ?? '',
    }
    groups[checkType].push(task)
    return task
  })
  return { tasks, groups, order: CHECK_TYPES.filter((t) => groups[t].length > 0) }
}

function normalizePlan(plan) {
  const tasks = Array.isArray(plan) ? plan : plan?.tasks ?? []
  const groups = { deterministic: [], semantic: [], cross_doc: [] }
  for (const t of tasks) groups[CHECK_TYPES.includes(t.checkType) ? t.checkType : 'deterministic'].push(t)
  return { tasks, groups, order: CHECK_TYPES.filter((t) => groups[t].length > 0) }
}