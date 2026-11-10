// src/rules/loadRules.js —— 规则加载（B2 Owner）
// 输入：docs/rules清单.md（队长发布，唯一规则来源）
// 输出：结构化规则数组，字段与清单列一一对应。加规则不改代码。

import { readFile } from 'node:fs/promises'

/**
 * @typedef {object} Rule
 * @property {string} ruleId
 * @property {string} title
 * @property {string} text          规则原文摘要
 * @property {string} type          日期/金额/比例/字段/格式/语义
 * @property {'deterministic'|'semantic'} method
 * @property {string} condition     判定条件（可代码化）
 * @property {'high'|'medium'|'low'} severity
 * @property {string} evidenceRequirement
 * @property {'P0'|'P1'|'P2'} priority
 * @property {string} owner
 */

const HEADER_HINTS = ['ruleId', '判定方式']

export async function loadRules(file) {
  const md = await readFile(file, 'utf-8')
  return parseRulesMarkdown(md)
}

export function parseRulesMarkdown(md) {
  const lines = md.split(/\r?\n/)
  const tableRows = lines.filter((l) => l.trim().startsWith('|')).map(splitRow)

  // 找表头（第一行同时包含 ruleId 与判定方式）
  const headerIdx = tableRows.findIndex((r) => HEADER_HINTS.every((h) => r.includes(h)))
  if (headerIdx < 0) throw new Error('规则清单里没找到表头（需包含 ruleId 与 判定方式 两列）')

  const header = tableRows[headerIdx]
  const col = (name) => header.indexOf(name)
  const idx = {
    ruleId: col('ruleId'),
    title: col('条款标题'),
    text: col('规则原文（摘要）') >= 0 ? col('规则原文（摘要）') : col('规则原文'),
    type: col('规则类型'),
    method: col('判定方式'),
    condition: col('判定条件（可代码化）') >= 0 ? col('判定条件（可代码化）') : col('判定条件'),
    severity: col('严重级别'),
    evidence: col('证据要求'),
    priority: col('优先级'),
    owner: col('归属'),
  }
  for (const [k, v] of Object.entries(idx)) {
    if (['title', 'text', 'evidence', 'owner'].includes(k)) continue
    if (v < 0) throw new Error(`规则清单缺列: ${k}`)
  }

  const rules = []
  for (const row of tableRows.slice(headerIdx + 1)) {
    const id = row[idx.ruleId]
    if (!id || !/^R\d{3}$/.test(id)) continue // 跳过分隔行/空行
    if (!['deterministic', 'semantic'].includes(row[idx.method])) {
      throw new Error(`${id} 的判定方式非法：${row[idx.method]}（只能是 deterministic/semantic）`)
    }
    rules.push({
      ruleId: id,
      title: row[idx.title] ?? id,
      text: row[idx.text] ?? '',
      type: row[idx.type] ?? '语义',
      method: row[idx.method],
      condition: row[idx.condition] ?? '',
      severity: row[idx.severity] ?? 'medium',
      evidenceRequirement: idx.evidence >= 0 ? row[idx.evidence] : '',
      priority: row[idx.priority] ?? 'P2',
      owner: idx.owner >= 0 ? row[idx.owner] : 'B2',
      source: 'rules清单.md',
    })
  }
  if (rules.length === 0) throw new Error('规则清单解析出 0 条规则，检查表格格式')
  return rules
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
}

/** 只取 P0 规则（14:40 卡点：先保证一条端到端，用这个裁剪演示范围） */
export function byPriority(rules, ...prios) {
  return rules.filter((r) => prios.includes(r.priority))
}
