// agent-server/src/skills/registry.js —— 技能注册表（skills 接线层）
// invokeSkill(name, input, ctx)：按名分发到技能实现；结果透传（不吞错、不改写错误码）。
// 阶段 1（PARSING + RULE_LOADING）：parseDocument（B2 解析技能）+ loadRules（内联）+ initCoverageMatrix。
// 阶段 2/3：retrieveContext / runDeterministic / verifyCoverage 在 EXECUTING / VERIFYING 接入。
// 错误约定：技能抛 SkillError（code/message/detail），编排层按 code 判定，不统一成 INTERNAL/SKILL_FAILED。

import { SkillError } from '../utils/timeout.js'
import { chat } from '../sdk/client.js'

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
  runSemantic: (input, ctx) => runSemanticImpl(input, ctx),
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
/** 关键词拆分（方向 1）：数组原样保留；字符串按 [,，、;；] 拆分、trim 去空；多输入合并去重 */
function splitKeywords(...inputs) {
  const out = new Set()
  for (const v of inputs) {
    const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，、;；]/) : []
    for (const k of arr) {
      const t = String(k).trim()
      if (t) out.add(t)
    }
  }
  return [...out]
}

function loadRulesImpl({ ruleManifest, ruleDocBlocks } = {}) {
  const manifest = Array.isArray(ruleManifest) ? ruleManifest : []
  return manifest.map((m) => ({
    ruleId: m.ruleId,
    ruleName: m.ruleName ?? m.ruleId,
    checkType: m.checkType ?? 'deterministic',
    severity: m.severity ?? 'medium',
    priority: m.priority ?? 'P2',
    keywords: splitKeywords(m.keywords, m.evidenceRequirement), // keywords 数组 + evidenceRequirement 逗号拆分，合并去重
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
  const all = [...(blockIndex?.values?.() ?? [])]
  const hits = []
  for (const block of all) {
    if (keywords.length === 0) break
    const text = typeof block?.text === 'string' ? block.text : ''
    if (keywords.some((k) => text.includes(k))) hits.push(block)
  }
  // 方向①：semantic/cross_doc 命中块做同页相邻扩展（命中块 + 同页前后各最多 2 块，总扩展 ≤5，去重保序）；
  // 候选过滤：剔除纯 heading / 短块 / 疑似目录行（不作为 evidence 候选，heading 字段保留供上下文）；
  // deterministic 不扩展、不过滤，保持原召回。
  const isSemantic = task?.checkType === 'semantic' || task?.checkType === 'cross_doc'
  const filterNoise = (list) => list.filter((b) => {
    const type = b?.type ?? ''
    const text = typeof b?.text === 'string' ? b.text.trim() : ''
    if (type === 'heading') return false
    if (text.length < 10) return false
    if (text.length < 30 && (/…+/.test(text) || /\.{3,}/.test(text) || /第[一二三四五六七八九十百\d]+[章节条附件]/u.test(text))) return false
    if (/^目录/.test(text)) return false
    return true
  })
  if (isSemantic && hits.length > 0 && all.length > 0) {
    const expanded = new Map() // blockId -> block（去重，保原文档顺序）
    for (const hit of hits) {
      const page = hit.page ?? null
      const peers = page === null ? all : all.filter((b) => b.page === page) // 同 page 相邻块（heading 无值时以 page 分组）
      const idx = peers.findIndex((b) => b.blockId === hit.blockId)
      if (idx === -1) { expanded.set(hit.blockId, hit); continue } // 找不到相邻块：返回原命中块，不报错
      for (let i = Math.max(0, idx - 2); i <= Math.min(peers.length - 1, idx + 2) && expanded.size < 5; i++) {
        expanded.set(peers[i].blockId, peers[i])
      }
      if (expanded.size >= 5) break // 总扩展块 ≤5，避免 token 暴涨
    }
    const cands = filterNoise([...expanded.values()])
    if (cands.length > 0) return { matched: true, blocks: cands, ruleId: task?.ruleId ?? null }
    return { matched: hits.length > 0, blocks: hits, ruleId: task?.ruleId ?? null } // 过滤后为空：回退原召回，不返回空
  }
  return { matched: hits.length > 0, blocks: hits, ruleId: task?.ruleId ?? null }
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

/**
 * runSemantic 技能：调 LLM 做语义比对，要求模型只输出 JSON。
 * 入参 { rule, contexts }；contexts 每条须带 blockId/docName/page/text。
 * prompt 约束：无证据不得 fail；quote 必须是某条 text 的连续子串；不确定给 review。
 * 解析失败重试 1 次；仍失败返回 { status:'review', reason:'LLM 输出非 JSON' }（chat 调用失败则 reason 带失败码）。
 * 返回 { result, usage }：usage 供 executor 累计 llmCalls/tokens；result 只带 blockId+quote（对齐交给 locateEvidence）。
 * @param {{rule?:object, contexts?:Array<{blockId?:string, docName?:string, page?:number, text?:string}>}} [input]
 * @param {{signal?:AbortSignal}} [ctx]
 * @returns {Promise<{result:object, usage:object|null}>}
 */
async function runSemanticImpl({ rule, contexts } = {}, ctx = {}) {
  const items = Array.isArray(contexts) ? contexts : []
  const ctxText = items.map((c, i) => `[块${i + 1}] blockId=${c.blockId ?? ''} docName=${c.docName ?? ''} 页码=${c.page ?? '-'}\n${c.text ?? ''}`).join('\n\n')
  const prompt = [
    '你是政府投资项目/合同合规审查专家。根据给定规则与资料片段，判定该规则是否满足。',
    `规则名：${rule?.ruleName ?? rule?.ruleId ?? ''}`,
    `规则要求：${rule?.logic ?? rule?.evidenceRequirement ?? ''}`,
    `严重级别：${rule?.severity ?? 'medium'}`,
    '资料片段：',
    ctxText || '（无候选片段）',
    '',
    '输出要求：1) 只输出一个 JSON，禁止 Markdown 代码块或任何解释文字；',
    '2) status 只能取 pass / fail / review；3) 无证据支撑时不得判 fail（只能 review 或 pass）；',
    '4) evidence 的 quote 必须逐字取自某片段的 text（连续子串，不得改写/拼接），可多条；',
    '5) 资料不足或不把握给 review；6) confidence 取 0~1 之间数值。',
    `输出格式：{"ruleId":"${rule?.ruleId ?? ''}","status":"pass|fail|review","evidence":[{"blockId":"<片段中的 blockId>","quote":"<原文精确连续片段>"}],"suggestion":"<一句话建议>","confidence":0.0}`,
  ].join('\n')
  const messages = [
    { role: 'system', content: '你是合规审查助手，只输出符合指定格式的 JSON 文本。' },
    { role: 'user', content: prompt },
  ]

  let lastErr = null
  let lastUsage = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await chat({ messages, signal: ctx?.signal, timeoutMs: 30000 })
      lastUsage = out.usage
      const text = (out.text ?? '').trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\s*```$/, '')
      const data = JSON.parse(text)
      const status = ['pass', 'fail', 'review'].includes(data?.status) ? data.status : 'review'
      const evidence = Array.isArray(data?.evidence)
        ? data.evidence.filter((e) => e && typeof e?.blockId === 'string' && typeof e?.quote === 'string' && e.quote.length > 0)
        : []
      return {
        result: {
          ruleId: typeof data?.ruleId === 'string' ? data.ruleId : rule?.ruleId,
          status,
          evidence,
          suggestion: typeof data?.suggestion === 'string' ? data.suggestion : undefined,
          confidence: Number.isFinite(data?.confidence) ? data.confidence : null,
          reason: status === 'pass' || status === 'fail' ? undefined : '语义判定为复核',
        },
        usage: lastUsage,
      }
    } catch (err) {
      lastErr = err
    }
  }
  // 两次失败：chat 调用失败（SdkError 携带 code）与输出非 JSON 区分
  const callFailed = typeof lastErr?.code === 'string'
  return {
    result: { status: 'review', reason: callFailed ? `LLM 调用失败：${lastErr.code}` : 'LLM 输出非 JSON' },
    usage: lastUsage ?? null,
  }
}
