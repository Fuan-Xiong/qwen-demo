// src/rules/parser/docx.js —— docx 解析（mammoth → HTML → 结构化 Block）
// 输入 docx buffer，输出"裸块"列表（无 blockId/偏移，由 index.js finalizeBlocks 收尾）。
// 纯函数 htmlToBlocks 可脱离 mammoth 单独测试。

import mammoth from 'mammoth'
import * as cheerio from 'cheerio'
import { normalizeText } from './utils.js'

/**
 * 解析 docx buffer → 裸块列表。
 * @param {{buffer:Buffer}} input
 * @returns {Promise<Array<{type:string, heading:string|null, text:string, rows?:string[][]}>>}
 */
export async function parseDocxBlocks({ buffer }) {
  if (!buffer || buffer.length === 0) throw new Error('docx 解析失败：buffer 为空')
  let html
  try {
    const res = await mammoth.convertToHtml({ buffer })
    html = res.value
  } catch (err) {
    throw new Error(`docx 转换失败（mammoth）: ${err.message}`)
  }
  if (!html || !html.trim()) throw new Error('docx 转换结果为空：文档无可用文本')
  return htmlToBlocks(html)
}

/**
 * 纯函数：把 mammoth 输出的 HTML 转成裸块。
 * 分类规则：h1-h6 → heading；p → paragraph；ul/ol 内 li → list_item；
 * table → 一个 table 块（rows + 行列文本）+ 每个单元格一个 table_cell 块；
 * heading 块之后的段落归属该 heading（heading 字段）。
 *
 * @param {string} html
 * @returns {Array<{type:string, heading:string|null, text:string, rows?:string[][]}>}
 */
export function htmlToBlocks(html) {
  const $ = cheerio.load(html)
  const blocks = []
  let currentHeading = null

  const push = (type, text, extra = {}) => {
    const t = normalizeText(text)
    if (!t) return
    if (type === 'heading') currentHeading = t
    blocks.push({ type, heading: currentHeading, text: t, ...extra })
  }

  /** 表格：先产出整体 table 块（rows + 行列文本），再逐个产出 table_cell 块 */
  const tableToBlocks = ($table) => {
    const rows = []
    const cellTexts = []
    // cheerio 会把 <tr> 包进 <tbody>，children('tr') 匹配不到行，故用 find
    $table.find('tr').each((_i, tr) => {
      const cells = $(tr).children('th,td').map((_j, cell) => normalizeText($(cell).text())).get()
      rows.push(cells)
      for (const cellText of cells) if (cellText) cellTexts.push(cellText)
    })
    const text = rows.map((r) => r.join(' | ')).join('\n')
    push('table', text, { rows })
    for (const cellText of cellTexts) push('table_cell', cellText)
  }

  const walkChildren = ($el) => {
    $el.children().each((_i, el) => {
      const tag = (el.tagName ?? '').toLowerCase()
      if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
        push('heading', $(el).text())
      } else if (tag === 'p') {
        push('paragraph', $(el).text())
      } else if (tag === 'li') {
        push('list_item', $(el).text())
      } else if (tag === 'table') {
        tableToBlocks($(el))
      } else if (tag === 'ul' || tag === 'ol') {
        $(el).children('li').each((_i, li) => push('list_item', $(li).text()))
      } else if (el.type === 'tag') {
        walkChildren($(el))
      }
    })
  }

  walkChildren($.root())
  if (blocks.length === 0) throw new Error('docx 未解析出任何 block')
  return blocks
}
