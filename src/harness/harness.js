// src/harness.js —— 主循环（B1 Owner）
// 链路：加载规则 → 解析文档 → 规划 → 执行(逐条) → 校验 → 汇总 → SSE 输出
// 四道闸：最大轮次 / 单步超时 / 重试换策略 / 无进展终止

import { randomUUID } from 'node:crypto'
import { config, log } from '../config.js'
import { Metrics } from './metrics.js'
import { loadRules, byPriority } from '../rules/loadRules.js'
import { parseDocument } from '../rules/parser/index.js'
import { compareRule } from '../rules/compareRule.js'
import { retrieveContext } from '../rules/retrieve.js'
import { buildCoverage } from '../rules/coverage.js'

/**
 * @param {object} req
 * @param {{docIds?:string[], docs?:any[], ruleSetId?:string, options?:object}} body
 * @param {object} sse   createSseWriter 返回对象
 * @param {AbortSignal} signal
 */
export async function runReview(body, sse, signal) {
  const reviewId = `rv-${Date.now()}-${randomUUID().slice(0, 4)}`
  const m = new Metrics()
  const opts = { ...config.harness, ...(body.options ?? {}) }

  const docs = await resolveDocs(body)
  const rules = await loadRules(config.rules.file)
  const runRules = isDemo(body) ? byPriority(rules, 'P0', 'P1') : rules

  sse.send('meta', {
    reviewId,
    documents: docs.map((d) => ({ docId: d.docId, docName: d.docName, pageCount: d.pageCount })),
    ruleTotal: runRules.length,
    ruleSetId: body.ruleSetId ?? config.rules.setId,
    startedAt: Date.now(),
  })

  const onText = (delta) => sse.send('message', { role: 'assistant', channel: 'text', delta, ruleId: null })
  const onThinking = (delta) => sse.send('message', { role: 'assistant', channel: 'thinking', delta, ruleId: null })
  const onUsage = (u) => m.addTokens(u).addDeterministic(u?.in === undefined ? 1 : 0) && undefined

  try {
    // ── 1. 解析 ──
    sse.send('progress', { stage: 'parse', stageLabel: '解析文档', percent: 5, detail: `${docs.length} 份文档` })
    m.begin('parse')
    const parsed = []
    for (const d of docs) {
      checkAbort(signal)
      const p = d.blocks ? d : await parseDocument(d)
      parsed.push(p)
      m.addDeterministic()
      sse.send('progress', {
        stage: 'parse', stageLabel: '解析文档',
        percent: Math.round(5 + (parsed.length / docs.length) * 10),
        detail: `${p.docName} 切出 ${p.blocks.length} 个 block`,
      })
    }
    m.end('parse')

    // ── 2. 规则 ──
    m.begin('rules')
    sse.send('progress', { stage: 'rules', stageLabel: '加载规则', percent: 18, detail: `${runRules.length} 条规则` })
    m.end('rules')

    // ── 3. 规划（round 有上限，防死循环）──
    m.begin('plan')
    sse.send('progress', { stage: 'plan', stageLabel: '规划检查项', percent: 26, detail: `maxRounds=${opts.maxRounds}` })
    m.end('plan')
    checkAbort(signal)

    // ── 4. 执行 ──
    m.begin('execute')
    const results = new Map()
    // 跨文档：一条规则可能要在多份文档里找（取第一个 non-pass 的结果）
    const tasks = []
    for (const rule of runRules) for (const doc of parsed) tasks.push({ rule, doc })

    let done = 0
    let round = 0
    let lastProgressCount = -1
    let stagnant = 0

    while (tasks.length && round < opts.maxRounds) {
      round += 1
      const pending = tasks.splice(0, tasks.length) // 本轮全部执行；下轮只跑失败项
      for (const { rule, doc } of pending) {
        checkAbort(signal)
        const prev = results.get(rule.ruleId)
        if (prev && prev.verdict !== 'review') continue // 已得明确结论，不重复判定
        let r
        try {
          r = await compareRule(rule, doc, { retrieveContext, signal, onText, onThinking, onUsage })
        } catch (err) {
          if (err.name === 'AbortError') throw err
          r = {
            ruleId: rule.ruleId, title: rule.title, verdict: 'review', severity: rule.severity,
            method: rule.method, reason: `执行异常（${err.name}），转人工复核`, confidence: 0.1, evidence: [],
          }
        }
        if (r.method === 'deterministic') m.addDeterministic()
        const keep = !prev || r.verdict !== 'review'
        if (keep) results.set(rule.ruleId, r)

        done += 1
        m.issues += r.verdict === 'fail' ? 1 : 0
        sse.send('rule_result', r)
        sse.send('message', {
          role: 'assistant', channel: 'text', ruleId: rule.ruleId,
          delta: `【${rule.ruleId} ${rule.title}】${verdictLabel(r.verdict)}：${r.reason}\n`,
        })
        sse.send('metrics', m.snapshot())
        sse.send('progress', {
          stage: 'execute', stageLabel: '逐条比对',
          percent: Math.round(30 + (results.size / runRules.length) * 55),
          detail: `已完成 ${results.size}/${runRules.length} 条规则（round ${round}）`,
        })

        // 无进展检测：本轮没有新增明确结论就累计，连续 2 次终止
        stagnant = results.size === lastProgressCount ? stagnant + 1 : 0
        lastProgressCount = results.size
        if (stagnant >= 2) {
          log.warn('连续两轮无进展，终止（防死循环）')
          tasks.length = 0
          break
        }
        // 未得明确结论的规则留到下轮（换策略由 retry 层处理）
        if (r.verdict === 'review' && round < opts.maxRounds) tasks.push({ rule, doc })
      }
    }
    m.end('execute')

    // ── 5. 校验 ──
    m.begin('verify')
    sse.send('progress', { stage: 'verify', stageLabel: '证据校验', percent: 90, detail: '检查无证据结论' })
    for (const [id, r] of results) {
      if (r.verdict === 'fail' && (!r.evidence || r.evidence.length === 0)) {
        results.set(id, { ...r, verdict: 'review', reason: `证据缺失，降级为复核：${r.reason}`, confidence: 0.3 })
      }
    }
    m.end('verify')

    // ── 6. 汇总 ──
    m.begin('report')
    sse.send('progress', { stage: 'report', stageLabel: '生成报告', percent: 98, detail: '' })
    const coverage = buildCoverage(runRules, results)
    const payload = buildResult(reviewId, parsed, runRules, results, coverage, m)
    m.end('report')
    sse.send('result', { payload })
    sse.send('progress', { stage: 'report', stageLabel: '生成报告', percent: 100, detail: '' })
    sse.send('done', { reviewId, status: payload.status, durationMs: Date.now() - m.startedAt })
    return payload
  } catch (err) {
    if (err.name === 'AbortError') {
      sse.send('error', { code: 'aborted', message: '用户已中断', retryable: false, stage: 'execute' })
      return null
    }
    log.error('评审失败', err)
    sse.send('error', {
      code: err.name === 'TimeoutError' ? 'llm_timeout' : 'internal',
      message: err.message, retryable: true,
    })
    return null
  }
}

function buildResult(reviewId, docs, rules, results, coverage, m) {
  const issues = [...results.values()]
    .filter((r) => r.verdict === 'fail' || r.verdict === 'review')
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .map((r) => ({
      ruleId: r.ruleId,
      verdict: r.verdict,
      severity: r.severity,
      title: r.title ?? r.ruleId,
      reason: r.reason,
      ...(r.suggestion ? { suggestion: r.suggestion } : {}),
      confidence: r.confidence ?? 0,
      method: r.method,
      evidence: r.evidence ?? [],
    }))

  const pass = [...results.values()].filter((r) => r.verdict === 'pass').length
  const fail = issues.filter((i) => i.verdict === 'fail').length
  const review = issues.filter((i) => i.verdict === 'review').length
  const riskLevel = fail === 0 ? 'low' : issues.some((i) => i.verdict === 'fail' && i.severity === 'high') ? 'high' : 'medium'

  return {
    reviewId,
    status: coverage.pending > 0 || review > 0 ? 'partial' : 'done',
    summary: {
      total: rules.length,
      pass,
      fail,
      review,
      riskLevel,
      conclusion: `共 ${rules.length} 条规则：${pass} 条合规，${fail} 条不合规，${review} 条需复核${
        coverage.pending ? `，${coverage.pending} 条未覆盖` : ''
      }。`,
    },
    issues,
    coverage,
    metrics: m.finalize(coverage),
    documents: docs.map((d) => ({ docId: d.docId, docName: d.docName, pageCount: d.pageCount })),
  }
}

/** 解析 docIds/docs：支持内存文档对象（CLI/测试）或 {docId, docName, buffer} 列表 */
async function resolveDocs(body) {
  const docs = []
  for (const d of body.docs ?? []) docs.push(d) // 已解析文档或原始 buffer 均支持
  if (docs.length === 0) {
    // 骨架阶段：未做上传持久化，用内存演示文档兜底（B2 接上传后替换此分支）
    const { demoParsed } = await import('../../mock/demo-doc.js')
    const id = body.docIds?.[0] ?? 'doc-001'
    docs.push(demoParsed(id))
  }
  if (docs.length === 0) throw Object.assign(new Error('未提供文档'), { name: 'BadRequest' })
  return docs
}

const isDemo = (body) => body.mode === 'demo' || body.ruleSetId === 'demo'

const severityRank = (s) => ({ low: 1, medium: 2, high: 3 }[s] ?? 0)
const verdictLabel = (v) => ({ pass: '合规', fail: '不合规', review: '需复核' }[v] ?? v)

function checkAbort(signal) {
  if (signal?.aborted) {
    const e = new Error('aborted')
    e.name = 'AbortError'
    throw e
  }
}
