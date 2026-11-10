// agent-server/src/skills/registry.js —— 技能注册表（skills 接线层）
// invokeSkill(name, input, ctx)：按名分发到技能实现；结果透传（不吞错、不改写错误码）。
// 阶段 1（PARSING + RULE_LOADING）：parseDocument（B2 解析技能）+ loadRules（内联）+ initCoverageMatrix。
// 阶段 2/3：retrieveContext / runDeterministic / verifyCoverage 在 EXECUTING / VERIFYING 接入。
// 错误约定：技能抛 SkillError（code/message/detail），编排层按 code 判定，不统一成 INTERNAL/SKILL_FAILED。

import { SkillError } from '../utils/timeout.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 技能实现表（懒加载：parseDocument 动态 import，避免启动期加载 pdfjs 等重依赖） */
const SKILLS = {
  parseDocument: async (input, ctx) => {
    const { parseDocumentSkill } = await import('../../../skills/parse-document/index.js')
    return parseDocumentSkill(input, ctx)
  },
  loadRules: (input, ctx) => loadRulesImpl(input),
  retrieveContext: async (input, ctx) => {
    await sleep(100) // 模拟真实检索耗时：让 stepTimeoutMs / abort 时序可观测
    return retrieveContextImpl(input)
  },
  runDeterministic: async (input, ctx) => {
    await sleep(100) // 模拟真实比对耗时：让 stepTimeoutMs / abort 时序可观测
    return runDeterministicImpl(input)
  },
  verifyCoverage: (input, ctx) => verifyCoverageImpl(input),
}

/**
 * 调用技能。
 * @param {string} name 技能名（parseDocument / loadRules / ...）
 * @param {object} input 技能输入（按各技能约定）
 * @param {object} [ctx] 上下文（run / signal / blockIndex 等，技能按需取用）
 * @returns {Promise<unknown>} 技能返回（透传）
 * @throws {SkillError} 技能不存在 → SKILL_NOT_FOUND；技能自身错误原样上抛
 */
export async function invokeSkill(name, input, ctx = {}) {
  const skill = SKILLS[name]
  if (!skill) throw new SkillError('SKILL_NOT_FOUND', `技能未注册：${name}`)
  return skill(input, ctx)
}

/**
 * loadRules 技能（内联实现）：ruleManifest → 统一 Rule 结构数组。
 * ruleManifest 为空数组时返回 []（不提前 return：保持"技能总是被调用、空输入 → 空输出"的约定）。
 * ruleDocBlocks 为解析重建的 blockIndex（阶段 2 检索上下文用，这里先接收）。
 * @param {{ruleManifest?:Array<object>, ruleDocBlocks?:Map}} [input]
 * @returns {Array<object>} Rule[]（ruleId/ruleName/checkType/severity/priority/keywords/sourceClause）
 */
function loadRulesImpl({ ruleManifest, ruleDocBlocks } = {}) {
  const manifest = Array.isArray(ruleManifest) ? ruleManifest : []
  return manifest.map((m) => ({
    ruleId: m.ruleId,
    ruleName: m.ruleName ?? m.ruleId,
    checkType: m.checkType ?? 'deterministic',
    severity: m.severity ?? 'medium',
    priority: m.priority ?? 'P2',
    keywords: Array.isArray(m.keywords) ? m.keywords
      : Array.isArray(m.evidenceRequirement) ? m.evidenceRequirement
        : typeof m.evidenceRequirement === 'string' ? [m.evidenceRequirement]
          : [],
    sourceClause: m.sourceClause ?? '',
  }))
}

/**
 * retrieveContext 技能（内联实现）：按规则 keywords 在 blockIndex 中检索候选块。
 * @param {{task?:object, blockIndex?:Map, options?:object}} [input]
 * @returns {{matched:boolean, blocks:Array<object>, ruleId:string|null}}
 */
function retrieveContextImpl({ task, blockIndex, options } = {}) {
  const keywords = Array.isArray(task?.keywords) ? task.keywords.filter((k) => typeof k === 'string' && k) : []
  const blocks = []
  for (const block of blockIndex?.values?.() ?? []) {
    if (keywords.length === 0) break
    const text = typeof block?.text === 'string' ? block.text : ''
    if (keywords.some((k) => text.includes(k))) blocks.push(block)
  }
  return { matched: blocks.length > 0, blocks, ruleId: task?.ruleId ?? null }
}

/**
 * runDeterministic 技能（内联实现）：确定性比对——检索命中关键词上下文 → pass，否则 fail。
 * @param {{task?:object, ctx?:object, options?:object}} [input]
 * @returns {{status:'pass'|'fail', confidence:number, reason:string}}
 */
function runDeterministicImpl({ task, ctx, options } = {}) {
  const hits = Array.isArray(ctx?.blocks) ? ctx.blocks : []
  if (hits.length > 0) {
    return { status: 'pass', confidence: 0.9, reason: `规则 ${task?.ruleId} 命中关键词上下文` }
  }
  return { status: 'fail', confidence: 0.8, reason: `未检索到规则 ${task?.ruleId} 要求的内容` }
}

/**
 * verifyCoverage 技能（内联实现）：统计覆盖度。
 * 空矩阵 → { total:0, done:0, review:0, failed:0, details:{} }（total=0 非 null，验收约定）。
 * @param {{results?:Array<object>, matrix?:Record<string,{status:string,ruleId?:string}>, blockIndex?:Map}} [input]
 * @returns {{total:number, done:number, review:number, failed:number, details:Record<string,string>}}
 */
function verifyCoverageImpl({ results, matrix, blockIndex } = {}) {
  const entries = Object.entries(matrix ?? {})
  const byStatus = {}
  const details = {}
  for (const [, cell] of entries) {
    const status = cell?.status ?? 'pending'
    byStatus[status] = (byStatus[status] ?? 0) + 1
    details[cell?.ruleId ?? '?'] = status
  }
  return {
    total: entries.length,
    done: byStatus.done ?? 0,
    review: byStatus.review ?? 0,
    failed: byStatus.failed ?? 0,
    details,
  }
}

/**
 * 规则覆盖矩阵初始化：每条规则铺 pending 单元格；空数组 → 空 Map（不抛错）。
 * @param {Array<object>} [rules] 统一 Rule 结构（需含 ruleId）
 * @returns {Map<string,{ruleId:string,status:string,attempts:number,result:object|null,reason:string|null}>}
 */
export function initCoverageMatrix(rules = []) {
  const matrix = new Map()
  for (const rule of rules) {
    matrix.set(rule.ruleId, { ruleId: rule.ruleId, status: 'pending', attempts: 0, result: null, reason: null })
  }
  return matrix
}
