// skills/parse-document/utils/block.js —— Block 纯工具（技能内部实现，自包含，不依赖 src/rules/parser）
// 统一数据结构与 docs/contracts.md 一致；失败抛 SkillError（见 ./errors.js），不静默吞错。

import { createHash } from 'node:crypto'
import { SkillError } from './errors.js'

/**
 * @param {string} s
 * @returns {string} 32 位小写十六进制 md5
 */
export function md5Hex(s) {
  return createHash('md5').update(String(s)).digest('hex')
}

/**
 * 按规格生成 blockId：md5(docId + ":" + blockIndex + ":" + heading + ":" + text)
 * heading 为 null 时按空串参与哈希（保证同一文档重复解析结果一致）。
 * blockIndex 为最终 blocks 列表序号（0-based）。
 *
 * @param {{docId:string, blockIndex:number, heading:string|null, text:string}} input
 * @returns {string}
 */
export function makeBlockId({ docId, blockIndex, heading, text }) {
  return md5Hex(`${docId}:${blockIndex}:${heading ?? ''}:${text}`)
}

/**
 * 计算每个 block 的 charStart/charEnd（fullText 内左闭右开偏移），拼接 fullText，
 * 并**用 fullText.slice(charStart, charEnd) 反校验**每个块都能还原出原 text。
 * 修改传入的 blocks（原地补偏移）。
 *
 * @param {Array<{text:string}>} blocks
 * @param {string} [separator] 块间连接符，默认 '\n'
 * @returns {{blocks:Array, fullText:string, separator:string}}
 * @throws {SkillError} INVALID_BLOCKS / OFFSET_MISMATCH
 */
export function buildFullText(blocks, separator = '\n') {
  if (!Array.isArray(blocks)) throw new SkillError('INVALID_BLOCKS', 'buildFullText 需要 blocks 数组')
  let offset = 0
  blocks.forEach((b, i) => {
    if (!b || typeof b.text !== 'string') {
      throw new SkillError('INVALID_BLOCKS', `第 ${i} 个 block 缺少 text 字段`, { blockIndex: i })
    }
    b.charStart = offset
    b.charEnd = offset + b.text.length
    offset = b.charEnd + separator.length
  })
  const fullText = blocks.map((b) => b.text).join(separator)
  // 反校验：偏移必须能切片还原原文，否则说明索引与拼接不一致（数据完整性断言）
  blocks.forEach((b, i) => {
    if (fullText.slice(b.charStart, b.charEnd) !== b.text) {
      throw new SkillError('OFFSET_MISMATCH', `block ${i} 无法从 fullText 切片还原`, {
        blockIndex: i, charStart: b.charStart, charEnd: b.charEnd,
      })
    }
  })
  return { blocks, fullText, separator }
}

/** 统一换行与全角空格：\r\n → \n、NBSP → 空格，并去掉首尾空白；不破坏中文字符 */
export function normalizeText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim()
}

/**
 * 把裸块收尾成正式 Block：统一补 blockId（按最终序号）、全局偏移、fullText，
 * 并收集**非致命 warnings**（不吞错、不伪造数据）：
 * - dropped_empty_blocks：空文本块被忽略的数量
 * - missing_page：fileType=pdf 但块缺 page
 * - page_out_of_range：块 page 超过 pageCount
 *
 * @param {Array<{type:string, heading?:string|null, text?:string, page?:number|null, bbox?:object, rows?:string[][]}>} rawBlocks
 * @param {{docId:string, docName:string, fileType:'docx'|'pdf'|'txt'|'md', pageCount:number}} meta
 * @returns {{blocks:Array<object>, fullText:string, separator:string, pageCount:number, warnings:Array<object>}}
 * @throws {SkillError} INVALID_META / INVALID_BLOCKS / EMPTY_RESULT / OFFSET_MISMATCH
 */
export function finalizeBlocks(rawBlocks, { docId, docName, fileType, pageCount }) {
  if (!rawBlocks || !Array.isArray(rawBlocks)) {
    throw new SkillError('INVALID_BLOCKS', 'finalizeBlocks 需要 rawBlocks 数组')
  }
  if (typeof docId !== 'string' || !docId) throw new SkillError('INVALID_META', 'docId 必填且为字符串', { docId })
  if (typeof docName !== 'string' || !docName) throw new SkillError('INVALID_META', 'docName 必填且为字符串', { docName })

  const warnings = []
  const blocks = []
  let dropped = 0
  for (const raw of rawBlocks) {
    const text = normalizeText(raw?.text)
    if (!text) { dropped += 1; continue }
    const page = raw.page ?? null
    const index = blocks.length // blockIndex = 最终列表序号（与 blockId 一致）
    if (fileType === 'pdf' && page == null) {
      warnings.push({ code: 'missing_page', blockIndex: index, message: 'pdf 块缺少页码（page=null）' })
    }
    if (page != null && Number.isFinite(pageCount) && pageCount > 0 && page > pageCount) {
      warnings.push({ code: 'page_out_of_range', blockIndex: index, page, pageCount, message: `块页码 ${page} 超出 pageCount=${pageCount}` })
    }
    blocks.push({
      blockId: makeBlockId({ docId, blockIndex: index, heading: raw.heading ?? null, text }),
      docId,
      docName,
      page,
      type: raw.type,
      heading: raw.heading ?? null,
      text,
      ...(raw.bbox ? { bbox: raw.bbox } : {}),
      ...(raw.rows ? { rows: raw.rows } : {}),
    })
  }
  if (dropped > 0) warnings.push({ code: 'dropped_empty_blocks', count: dropped, message: `忽略 ${dropped} 个空文本块` })
  if (blocks.length === 0) throw new SkillError('EMPTY_RESULT', '解析结果为空：文档无可用文本')

  const { blocks: finalized, fullText, separator } = buildFullText(blocks)
  return { blocks: finalized, fullText, separator, pageCount, warnings }
}
