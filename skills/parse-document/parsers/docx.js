// skills/parse-document/parsers/docx.js —— docx 解析器（技能实现的一部分，自包含，不依赖 src/rules/parser）
// 流程：读文件 → mammoth.convertToHtml → cheerio 结构化（h1-h6/p/ul-ol-li/table）→
//       utils/block.js finalizeBlocks 统一收口（blockId + 全局偏移 + fullText）。
// 失败抛 SkillError（见 utils/errors.js），不静默吞错。

import { readFile } from 'node:fs/promises'
import mammoth from 'mammoth'
import * as cheerio from 'cheerio'
import { normalizeText, finalizeBlocks } from '../utils/block.js'
import { SkillError, toSkillError } from '../utils/errors.js'

/**
 * 解析本地 docx 文件。
 *
 * @param {string} filePath 本地 docx 文件路径
 * @param {{docId:string, docName:string}} meta
 * @returns {Promise<{blocks:Array<object>, fullText:string, pageCount:number, warnings:Array<object>}>}
 *   blocks：正式 Block（blockId/偏移/fullText 由 finalizeBlocks 补齐）；
 *   docx 无真实分页：page 一律 null，pageCount=0，warnings 首条为 { code:'no_page_info' }。
 * @throws {SkillError}
 *   INVALID_INPUT（filePath 为空）/ INVALID_META / READ_FAILED（文件读取失败）/
 *   EMPTY_INPUT（文件为空）/ PARSE_FAILED（mammoth 转换失败）/ EMPTY_RESULT（无可用文本）
 */
export async function parseDocx(filePath, { docId, docName }) {
  if (typeof filePath !== 'string' || !filePath) throw new SkillError('INVALID_INPUT', 'parseDocx 需要 filePath')
  if (typeof docId !== 'string' || !docId) throw new SkillError('INVALID_META', 'docId 必填且为字符串')
  if (typeof docName !== 'string' || !docName) throw new SkillError('INVALID_META', 'docName 必填且为字符串')

  let buffer
  try {
    buffer = await readFile(filePath)
  } catch (err) {
    // 统一 READ_FAILED（原始 code 如 ENOENT 见 detail.originalCode）
    throw toSkillError(err, 'READ_FAILED', { forceCode: true })
  }
  if (!buffer || buffer.length === 0) throw new SkillError('EMPTY_INPUT', 'docx 文件为空', { filePath })

  let html
  try {
    const res = await mammoth.convertToHtml({ buffer })
    html = res.value
  } catch (err) {
    throw toSkillError(err, 'PARSE_FAILED', { forceCode: true })
  }
  if (!html || !html.trim()) throw new SkillError('EMPTY_RESULT', 'docx 转换结果为空：文档无可用文本', { docName })

  const rawBlocks = htmlToRawBlocks(html)
  const out = finalizeBlocks(rawBlocks, { docId, docName, fileType: 'docx', pageCount: 0 })
  const warnings = [{ code: 'no_page_info', message: 'docx 无真实分页信息，所有块 page=null' }, ...out.warnings]
  return { blocks: out.blocks, fullText: out.fullText, pageCount: out.pageCount, warnings }
}

/**
 * mammoth 输出的 HTML → 裸块列表（type/heading/text/rows）。
 * 分类：h1-h6 → heading；p → paragraph；ul/ol 内 li → list_item；
 * table → 先产出整体 table 块（rows 二维数组 + 行列拼接文本），再逐个产出 table_cell 块。
 * heading 向后继承（最近的 heading 块文本）；空文本一律跳过。
 *
 * @param {string} html
 * @returns {Array<{type:string, heading:string|null, text:string, rows?:string[][]}>}
 */
function htmlToRawBlocks(html) {
  const $ = cheerio.load(html)
  const blocks = []
  let currentHeading = null

  const push = (type, text, extra = {}) => {
    const t = normalizeText(text)
    if (!t) return // 空段落/空单元格跳过
    if (type === 'heading') currentHeading = t // heading 向后继承
    blocks.push({ type, heading: currentHeading, text: t, ...extra })
  }

  const tableToRawBlocks = ($table) => {
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

  const walk = ($el) => {
    $el.children().each((_i, el) => {
      const tag = (el.tagName ?? '').toLowerCase()
      if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
        push('heading', $(el).text())
      } else if (tag === 'p') {
        push('paragraph', $(el).text())
      } else if (tag === 'li') {
        push('list_item', $(el).text())
      } else if (tag === 'table') {
        tableToRawBlocks($(el))
      } else if (tag === 'ul' || tag === 'ol') {
        $(el).children('li').each((_i, li) => push('list_item', $(li).text()))
      } else if (el.type === 'tag') {
        walk($(el)) // 容器（html/body 等）递归
      }
    })
  }

  walk($.root())
  return blocks
}