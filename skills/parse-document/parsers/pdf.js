// skills/parse-document/parsers/pdf.js —— pdf 解析器（技能实现的一部分，自包含，不依赖 src/rules/parser）
// 用 pdfjs-dist legacy build 逐页 getTextContent：
//   - 按 y 分组分行（基线差 ≤ 0.35×字号视为同一行）、行内按 x 排序、按间隙拼接
//   - 行间水平间隙过大 → 识别为多栏并拆分，加 multi_column warning
//   - page 1-based；includeBbox 时输出近似 bbox（PDF 用户空间坐标，y 向上）
//   - 全文无文本层（扫描件）抛 SkillError('OCR_REQUIRED')
// 错误一律抛 SkillError（见 utils/errors.js），不静默吞错。

import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { normalizeText, finalizeBlocks } from '../utils/block.js'
import { SkillError, toSkillError } from '../utils/errors.js'

// pdfjs-dist 包内预置 CMap（CJK 中文字体解码必需），跟随包路径解析，与 cwd 无关
const require = createRequire(import.meta.url)
const PDFJS_CMAPS = `${dirname(require.resolve('pdfjs-dist/package.json'))}/cmaps`

/** 列表项行首模式：项目符号 / 数字序号 / 括号数字 */
const BULLET_RE = /^[•·▪●○■□◆*]\s*|^\d+[.、)）]\s*|^[（(]\s*\d+\s*[）)]\s*/

/**
 * 解析本地 pdf 文件。
 *
 * @param {string} filePath 本地 pdf 文件路径
 * @param {{docId:string, docName:string, includeBbox?:boolean}} meta
 * @returns {Promise<{blocks:Array<object>, fullText:string, pageCount:number, warnings:Array<object>}>}
 *   blocks：正式 Block（blockId/偏移/fullText 由 finalizeBlocks 补齐）；
 *   page 1-based；includeBbox（默认 true）时带近似 bbox。
 *   warnings：multi_column（多栏识别，含页码）/ page_no_text（个别页无文本层）/
 *   finalizeBlocks 的非致命告警。
 * @throws {SkillError}
 *   INVALID_INPUT / INVALID_META / READ_FAILED / EMPTY_INPUT / PARSE_FAILED /
 *   OCR_REQUIRED（全文无文本层，疑似扫描件）
 */
export async function parsePdf(filePath, { docId, docName, includeBbox = true }) {
  if (typeof filePath !== 'string' || !filePath) throw new SkillError('INVALID_INPUT', 'parsePdf 需要 filePath')
  if (typeof docId !== 'string' || !docId) throw new SkillError('INVALID_META', 'docId 必填且为字符串')
  if (typeof docName !== 'string' || !docName) throw new SkillError('INVALID_META', 'docName 必填且为字符串')

  let buffer
  try {
    buffer = await readFile(filePath)
  } catch (err) {
    throw toSkillError(err, 'READ_FAILED', { forceCode: true })
  }
  if (!buffer || buffer.length === 0) throw new SkillError('EMPTY_INPUT', 'pdf 文件为空', { filePath })

  let doc
  let task = null
  try {
    task = getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
      // 缺省时中文 PDF（CID 字体 + 预置 CMap）会 loadFont translateFont failed，
      // 全部文本项解码失败被误判为扫描件（OCR_REQUIRED）
      cMapUrl: `${PDFJS_CMAPS}/`,
      cMapPacked: true,
    })
    doc = await task.promise
  } catch (err) {
    throw toSkillError(err, 'PARSE_FAILED', { forceCode: true })
  }

  const warnings = []
  const rawBlocks = []
  const colPages = []
  let numPages = 0
  try {
    numPages = doc.numPages
    for (let pageNo = 1; pageNo <= numPages; pageNo += 1) {
      const page = await doc.getPage(pageNo)
      const content = await page.getTextContent()
      const { blocks, multiColumn } = pageItemsToBlocks(content.items ?? [], pageNo, { includeBbox })
      if (multiColumn) colPages.push(pageNo)
      if (blocks.length === 0) {
        warnings.push({ code: 'page_no_text', page: pageNo, message: `第 ${pageNo} 页无文本层` })
      }
      rawBlocks.push(...blocks)
    }
  } catch (err) {
    throw toSkillError(err, 'PARSE_FAILED', { forceCode: true })
  } finally {
    // pdfjs-dist v6：destroy() 在 loading task 上（PDFDocumentProxy 已无该方法）
    if (task) await task.destroy().catch(() => {})
  }

  if (colPages.length > 0) {
    warnings.unshift({ code: 'multi_column', pages: colPages, message: `检测到多栏布局（第 ${colPages.join('、')} 页），已按列拆分` })
  }
  if (rawBlocks.length === 0) {
    throw new SkillError('OCR_REQUIRED', 'PDF 未检测到文本层（疑似扫描件），需先 OCR 再解析', { docName, pageCount: numPages })
  }

  const out = finalizeBlocks(rawBlocks, { docId, docName, fileType: 'pdf', pageCount: numPages })
  return { blocks: out.blocks, fullText: out.fullText, pageCount: out.pageCount, warnings: [...warnings, ...out.warnings] }
}

/**
 * 纯逻辑：一页的文本项 → 行（按 y 分组 + 列拆分）→ 块。
 * 块的断点：标题与正文交替（标题块不得吞并紧随正文行，同字号标题续行可合并）/
 * 列表项行首 / 行间垂直间隙 > 0.55×字号 / 与当前块无水平重叠（分栏内容不合并）。
 *
 * @param {Array<{str:string, transform?:number[], width?:number, height?:number}>} items
 * @param {number} page 1-based 页码
 * @param {{includeBbox:boolean}} opts
 * @returns {{blocks:Array<object>, multiColumn:boolean}}
 */
function pageItemsToBlocks(items, page, { includeBbox }) {
  const { lines, multiColumn } = groupLines(items)
  const heights = lines.map((l) => l.fontSize).filter((h) => h > 0)
  const median = medianOf(heights)

  const blocks = []
  let cur = null
  let prev = null
  for (const line of lines) {
    if (!line.text) continue // 空白行：段落分隔
    const isHeading = median > 0 && line.fontSize > median * 1.18
    const isListItem = BULLET_RE.test(line.text)
    const bigGap = prev != null && prev.box.bottom - line.box.top > line.fontSize * 0.55
    const noOverlap = cur != null && !overlaps(cur.box, line.box) // 分栏内容不合并
    const curIsHeading = cur != null && cur.type === 'heading'
    // 标题与正文交替必须断块：标题块不得吞并紧随的正文行（同字号标题续行可合并）
    const headingFlip = isHeading !== curIsHeading
    if (!cur || headingFlip || isListItem || bigGap || noOverlap) {
      if (cur) blocks.push(finish(cur, includeBbox))
      cur = { type: isHeading ? 'heading' : isListItem ? 'list_item' : 'paragraph', page, parts: [line.text], box: line.box }
    } else {
      cur.parts.push(line.text)
      cur.box = unionBox(cur.box, line.box)
    }
    prev = line
  }
  if (cur) blocks.push(finish(cur, includeBbox))
  return { blocks, multiColumn }
}

function finish(cur, includeBbox) {
  const b = {
    type: cur.type,
    heading: null, // pdf 无章节结构
    page: cur.page,
    text: cur.parts.reduce((acc, t) => (acc === '' ? t : joinLines(acc, t)), ''),
  }
  if (includeBbox) b.bbox = cur.box
  return b
}

// ── 行装配：按 y 分行、按 x 排序、列拆分、行内拼接 ────────

function groupLines(items) {
  const clean = (items ?? []).filter((it) => it.str && it.str.trim().length > 0)
  if (clean.length === 0) return { lines: [], multiColumn: false }
  const heights = clean.map((it) => Number(it.height) || 0).filter((h) => h > 0)
  const fontSize = medianOf(heights) || 10
  const tolY = fontSize * 0.35 // 同行基线容差

  // 项指标：x0/y0 取文本矩阵位移；bbox 为近似包围盒（基线上 0.8h / 下 0.2h）
  const prepared = clean
    .map((it) => {
      const x0 = Number(it.transform?.[4]) || 0
      const y0 = Number(it.transform?.[5]) || 0
      const h = Number(it.height) || fontSize
      const w = Number(it.width) || 0
      return { str: it.str, x0, y0, h, box: { x0, top: y0 + h * 0.8, x1: x0 + w, bottom: y0 - h * 0.2 } }
    })
    .sort((a, b) => b.y0 - a.y0 || a.x0 - b.x0) // 页面从上到下，同行按 x 从左到右

  // 按 y 分组分行
  const lines = []
  for (const p of prepared) {
    const last = lines[lines.length - 1]
    if (last && Math.abs(last.y0 - p.y0) <= tolY) {
      last.parts.push(p)
      last.maxH = Math.max(last.maxH, p.h)
    } else {
      lines.push({ y0: p.y0, parts: [p], maxH: p.h })
    }
  }

  // 列拆分：同一行内相邻项水平间隙过大 → 拆成多行（并标记多栏）
  const out = []
  let multiColumn = false
  for (const line of lines) {
    const parts = [...line.parts].sort((a, b) => a.x0 - b.x0)
    const span = parts[parts.length - 1].box.x1 - parts[0].box.x0
    const threshold = Math.max(span * 0.2, line.maxH * 6) // 页宽 20% 或约 6 个字符宽
    const subs = []
    let cur = { parts: [], maxH: line.maxH }
    for (const p of parts) {
      const prev = cur.parts[cur.parts.length - 1]
      if (prev && p.x0 - prev.box.x1 > threshold) {
        subs.push(cur)
        cur = { parts: [], maxH: line.maxH }
      }
      cur.parts.push(p)
    }
    subs.push(cur)
    if (subs.length > 1) multiColumn = true
    for (const s of subs) out.push(toTextLine(s))
  }
  return { lines: out, multiColumn }
}

/** 行内拼接：项间水平间隙 > 0.3 字符宽补空格（中文内容靠间隙不误判） */
function toTextLine(line) {
  const parts = [...line.parts].sort((a, b) => a.x0 - b.x0)
  let text = ''
  let box = null
  let prevX1 = null
  for (const p of parts) {
    if (prevX1 != null && p.x0 - prevX1 > line.maxH * 0.3) text += ' '
    text += p.str
    prevX1 = p.box.x1
    box = unionBox(box, p.box)
  }
  return { text: normalizeText(text), box, fontSize: line.maxH }
}

/** 相邻行拼接：接缝任一侧为汉字不补空格（中文换行），否则补一个空格 */
function joinLines(a, b) {
  const isHan = (c) => /\p{Script=Han}/u.test(c)
  return isHan(a.slice(-1)) || isHan(b.slice(0, 1)) ? a + b : `${a} ${b}`
}

function overlaps(a, b) {
  return a.x1 >= b.x0 && b.x1 >= a.x0
}

function unionBox(a, b) {
  if (!a) return { ...b }
  return {
    x0: Math.min(a.x0, b.x0),
    top: Math.max(a.top, b.top),
    x1: Math.max(a.x1, b.x1),
    bottom: Math.min(a.bottom, b.bottom),
  }
}

function medianOf(nums) {
  if (!nums.length) return 0
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}