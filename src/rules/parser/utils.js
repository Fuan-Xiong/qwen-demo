// src/rules/parser/utils.js —— 解析层纯工具（无副作用，可单独测试）
// 统一数据结构见 docs/contracts.md；所有函数都是纯函数，不依赖全局状态。

import { createHash } from 'node:crypto'

/**
 * @param {string} text
 * @returns {string} 32 位小写十六进制 md5
 */
export function md5Hex(text) {
  return createHash('md5').update(String(text)).digest('hex')
}

/**
 * 按规格生成 blockId：md5(docId + ":" + blockIndex + ":" + heading + ":" + text)
 * heading 为 null 时按空串参与哈希（保证同一文档重复解析结果一致）。
 *
 * @param {{docId:string, blockIndex:number, heading:string|null, text:string}} input
 * @returns {string}
 */
export function buildBlockId({ docId, blockIndex, heading, text }) {
  return md5Hex(`${docId}:${blockIndex}:${heading ?? ''}:${text}`)
}

/** 统一换行与全角空格：\r\n → \n、NBSP → 空格，并去掉首尾空白 */
export function normalizeText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim()
}

/**
 * txt/md 及 OCR 文本 → 裸块：按空行切段，type 一律 paragraph，无分页信息（页码由调用方注入）。
 * @param {string} text
 * @returns {Array<{type:string, heading:null, text:string}>}
 */
export function textToBlocks(text) {
  return normalizeText(text)
    .split(/\n\s*\n/)
    .map((seg) => ({ type: 'paragraph', heading: null, text: normalizeText(seg) }))
    .filter((b) => b.text.length > 0)
}

/**
 * 以 separator（默认 '\n'）连接各块 text 得到全文，并把 charStart/charEnd
 * 写成"全文内"的左闭右开偏移。修改传入的 blocks（原地）。
 *
 * @param {Array<{text:string}>} blocks
 * @param {string} [separator]
 * @returns {{blocks:Array, fullText:string, separator:string}}
 */
export function assignGlobalOffsets(blocks, separator = '\n') {
  let offset = 0
  for (const b of blocks) {
    b.charStart = offset
    b.charEnd = offset + b.text.length
    offset = b.charEnd + separator.length
  }
  return {
    blocks,
    fullText: blocks.map((b) => b.text).join(separator),
    separator,
  }
}

/**
 * 把裸块列表收尾成正式 Block：
 * - 注入 docId / docName / page（null 兜底）/ type / heading / text
 * - 生成 blockId（blockIndex = 最终列表序号）
 * - 计算全文与全局 charStart/charEnd
 *
 * @param {Array<{type:string, heading:string|null, text:string, page?:number, bbox?:object, rows?:string[][]}>} rawBlocks
 * @param {{docId:string, docName:string}} meta
 * @returns {{blocks:Array<object>, fullText:string, separator:string}}
 */
export function finalizeBlocks(rawBlocks, { docId, docName }) {
  const blocks = rawBlocks.map((b, blockIndex) => ({
    blockId: buildBlockId({ docId, blockIndex, heading: b.heading, text: b.text }),
    docId,
    docName,
    page: b.page ?? null,
    type: b.type,
    heading: b.heading ?? null,
    text: b.text,
    ...(b.bbox ? { bbox: b.bbox } : {}),
    ...(b.rows ? { rows: b.rows } : {}),
  }))
  return assignGlobalOffsets(blocks)
}

/** Block.type 合法取值（规格限定） */
export const BLOCK_TYPES = ['paragraph', 'heading', 'table', 'table_cell', 'list_item']
