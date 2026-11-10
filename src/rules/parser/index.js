// src/rules/parser/index.js —— 解析主入口（docx/pdf/txt/md/图片 → ParsedDoc）
// 职责：按扩展名分派 → 解析出裸块 → finalizeBlocks 统一生成 blockId + 全局偏移。
// 图片（jpg/png/webp/bmp）与 PDF 扫描页经 ocr.js 调内网 VL 模型抽取原文。
// 导出名与旧 src/rules/parser.js 保持一致（parseDocument/parseFile/toFullText），
// 避免改动上层调用方逻辑。

import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { finalizeBlocks, textToBlocks } from './utils.js'
import { parseDocxBlocks } from './docx.js'
import { parsePdfBlocks } from './pdf.js'
import { parseImageBlocks, IMAGE_MIME } from './ocr.js'

/**
 * 主入口：按扩展名分派解析。
 *
 * @param {{buffer:Buffer, docName?:string, docId?:string}} input
 * @returns {Promise<{
 *   docId:string, docName:string, pageCount:number, fullText:string,
 *   separator:string, blocks:Array<object>
 * }>}
 *   blocks：见 docs/contracts.md 的 Block；charStart/charEnd 为全文内左闭右开偏移。
 *   pageCount：pdf 为真实页数；docx/txt 无分页信息时为 0。
 */
export async function parseDocument(input) {
  const { buffer, docName = 'document', docId = randomUUID() } = input
  if (!buffer || buffer.length === 0) throw new Error(`解析失败（${docName}）：buffer 为空`)
  const ext = extname(docName).toLowerCase()
  const meta = { docId, docName: basename(docName) }

  let raw
  if (ext === '.docx') raw = await parseDocxBlocks({ buffer })
  else if (ext === '.pdf') raw = await parsePdfBlocks({ buffer })
  else if (ext === '.txt' || ext === '.md') raw = textToBlocks(String(buffer))
  else if (IMAGE_MIME[ext]) raw = await parseImageBlocks({ buffer, docName })
  else throw new Error(`暂不支持的格式: ${ext || '(无扩展名)'}（支持 .docx/.pdf/.txt/.md 及图片 ${Object.keys(IMAGE_MIME).join('/')}）`)

  const { blocks, fullText, separator } = finalizeBlocks(raw, meta)
  if (blocks.length === 0) throw new Error(`解析结果为空：${meta.docName} 无可用文本`)

  const pages = blocks.map((b) => b.page).filter((p) => p != null)
  const pageCount = pages.length ? Math.max(...pages) : 0
  return { docId: meta.docId, docName: meta.docName, pageCount, fullText, separator, blocks }
}

/** 从本地路径读取并解析（CLI/联调用） */
export async function parseFile(path) {
  const buffer = await readFile(path)
  return parseDocument({ buffer, docName: basename(path) })
}

/** 全文纯文本（检索用；不要整篇塞给模型） */
export function toFullText(parsed) {
  return parsed.fullText
}
