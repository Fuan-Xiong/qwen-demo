// src/rules/compareRule.js —— 规则比对（B2 Owner）
// 原则：确定性规则优先代码比对（零 Token）；语义规则才调 LLM。
// 返回结构严格对齐 docs/result.schema.json 的 issues[]，并强制"无证据不判 fail"。

import { complete } from '../harness/sdkClient.js'
import { findEvidence } from './evidence.js'

/**
 * @returns {Promise<{ruleId, title, verdict:'pass'|'fail'|'review',
 *   severity, method, reason, suggestion?, confidence, evidence:[]}>}
 */
export async function compareRule(rule, doc, ctx = {}) {
  if (rule.method === 'deterministic') return compareDeterministic(rule, doc)

  // semantic：先检索切片，绝不传全文
  const { retrieveContext } = ctx
  if (!retrieveContext) throw new Error('semantic 规则需要 ctx.retrieveContext')
  const slices = retrieveContext(rule, doc)
  if (!slices.length) {
    return review(rule, '文档中未检索到相关条款内容，无法判定', [], 0.3)
  }

  const prompt = buildPrompt(rule, slices)
  let res
  try {
    res = await complete({ prompt, signal: ctx.signal, onText: ctx.onText, onThinking: ctx.onThinking })
    ctx.onUsage?.({ in: res.usage.in, out: res.usage.out, stage: 'execute' })
  } catch (err) {
    if (err.name === 'AbortError') throw err
    return review(rule, `模型调用异常（${err.name}），转人工复核`, [], 0.2)
  }

  const parsed = safeJson(res.text)
  if (!parsed) return review(rule, '模型返回无法解析为 JSON，转人工复核', [], 0.2)

  const verdict = ['pass', 'fail', 'review'].includes(parsed.verdict) ? parsed.verdict : 'review'
  const evidence = (parsed.evidence ?? [])
    .map((e) => findEvidence(doc, { snippet: e.snippet ?? e.text ?? '', blockId: e.blockId }))
    .filter(Boolean)

  // 铁律：无证据不判 fail
  if (verdict === 'fail' && evidence.length === 0) {
    return review(rule, `模型判定不合规但未能定位原文证据：${parsed.reason ?? ''}`.trim(), [], 0.35)
  }
  const confidence = clamp(Number(parsed.confidence ?? 0.6))
  if (verdict !== 'review' && confidence < 0.7) {
    return review(rule, `置信度不足（${confidence}）：${parsed.reason ?? ''}`, evidence, confidence)
  }

  return {
    ruleId: rule.ruleId,
    title: rule.title,
    verdict,
    severity: rule.severity,
    method: 'semantic',
    reason: parsed.reason ?? (verdict === 'pass' ? '符合要求' : '不符合要求'),
    suggestion: parsed.suggestion || undefined,
    confidence,
    evidence,
  }
}

/** 确定性比对：从判定条件里提取"取值正则 + 运算符 + 阈值" */
export function compareDeterministic(rule, doc) {
  const spec = parseCondition(rule.condition)
  if (!spec) {
    return review(rule, `判定条件无法解析为确定性规则，建议改为 semantic：${rule.condition}`, [], 0.2)
  }
  const hits = []
  for (const block of doc.blocks) {
    for (const m of block.text.matchAll(spec.pattern)) {
      // 自定义正则带捕获组时取组 1，否则取整个匹配（顶层 \d+ 会把数字放到 m[0]）
      const value = Number(String(m[1] ?? m[0]).replace(/,/g, ''))
      if (Number.isNaN(value)) continue
      hits.push({ block, value, snippet: m[0] })
    }
  }
  if (hits.length === 0) {
    return review(rule, `未在文档中找到可判定的取值（期望匹配「${spec.pattern.source}」，要求「${spec.describe}」）`, [], 0.4)
  }

  const bad = hits.filter((h) => !spec.test(h.value))
  if (bad.length === 0) {
    const h = hits[0]
    return {
      ruleId: rule.ruleId, title: rule.title, verdict: 'pass', severity: rule.severity,
      method: 'deterministic', reason: `取值为 ${h.value}，符合「${spec.describe}」`, confidence: 0.99,
      evidence: [findEvidence(doc, { blockId: h.block.blockId, snippet: h.snippet })].filter(Boolean),
    }
  }
  const h = bad[0]
  return {
    ruleId: rule.ruleId, title: rule.title, verdict: 'fail', severity: rule.severity,
    method: 'deterministic',
    reason: `取值为 ${h.value}，不满足「${spec.describe}」`,
    suggestion: spec.suggestion,
    confidence: 0.99,
    evidence: [findEvidence(doc, { blockId: h.block.blockId, snippet: h.snippet })].filter(Boolean),
  }
}

/**
 * 解析形如：断言 N >= 90 / 断言 N ≤ 30 / 断言 N 不少于 12
 * 取值正则默认 /\d[\d,]*(?:\.\d+)?/g，可用 "正则:/pattern/g" 覆盖（必须带捕获组）
 */
export function parseCondition(condition) {
  if (!condition) return null
  // 正则可能含 / 与 % 等字符，用"后置断言"定位，不用贪婪的符号白名单
  const custom = condition.match(/正则[:：]?\s*(\/.+?\/[gimsuy]*)(?=\s*断言|[，,；;]|$)/)
  const prose = custom ? condition.replace(custom[0], '') : condition
  const normalized = prose.replace(/≤/g, '<=').replace(/≥/g, '>=')
  const opClause = /([<>]=?|不少于|不得少于|不低于|不高于|不得高于|不超过|最多|至少)\s*(\d+(?:\.\d+)?)/g
  let compact = null
  for (const hit of normalized.matchAll(opClause)) compact = hit // 取最后一个运算符+阈值
  if (!compact) return null
  const [, op, raw] = compact
  const threshold = Number(raw)
  const test = {
    '>=': (v) => v >= threshold, '≥': (v) => v >= threshold,
    '<=': (v) => v <= threshold, '≤': (v) => v <= threshold,
    '>': (v) => v > threshold, '<': (v) => v < threshold,
    '不少于': (v) => v >= threshold, '不得少于': (v) => v >= threshold, '不低于': (v) => v >= threshold,
    '至少': (v) => v >= threshold,
    '不高于': (v) => v <= threshold, '不得高于': (v) => v <= threshold, '不超过': (v) => v <= threshold,
    '最多': (v) => v <= threshold,
  }[op]
  if (!test) return null

  // 默认取值正则：数字可能带千分位（1,280,000）与小数，统一取整段后去掉逗号
  let pattern = /\d[\d,]*(?:\.\d+)?/g
  if (custom) {
    const src = custom[1]
    const lastSlash = src.lastIndexOf('/')
    pattern = new RegExp(src.slice(1, lastSlash), src.slice(lastSlash + 1))
  }
  return {
    pattern, group: 1, test,
    describe: `${op} ${threshold}`,
    suggestion: undefined,
  }
}

function buildPrompt(rule, slices) {
  const context = slices
    .map((s) => `[${s.blockId} | 第${s.page}页]\n${s.text}`)
    .join('\n\n')
  return `你是合同合规审查员。只依据给定条款内容作答，不得引用外部知识。

【规则】${rule.ruleId} ${rule.title}
【要求】${rule.text}
【判定条件】${rule.condition}

【条款内容】
${context}

只输出 JSON（不要 markdown 代码块）：
{"verdict":"pass|fail|review","reason":"一句话原因","suggestion":"整改建议，pass 可省略","confidence":0到1,"evidence":[{"blockId":"p-000123","snippet":"命中的原文片段，必须逐字来自上文"}]}
要求：findings 必须有原文依据；条款缺失或表述含糊时给 review，不要猜。`
}

function safeJson(text) {
  if (!text) return null
  const cleaned = text.replace(/```json|```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(cleaned.slice(start, end + 1)) } catch { return null }
}

const clamp = (n) => (Number.isNaN(n) ? 0.5 : Math.min(1, Math.max(0, n)))

function review(rule, reason, evidence, confidence) {
  return {
    ruleId: rule.ruleId, title: rule.title, verdict: 'review', severity: rule.severity,
    method: rule.method, reason, confidence, evidence,
  }
}
