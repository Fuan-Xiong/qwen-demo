// skills/parse-document/index.js —— parse-document 技能主入口（编排层）
// 流程：validateInput → 按 maxConcurrency 分批并发 → 按扩展名调 parseDocx/parsePdf →
//       汇总 documents/metrics；异常返回 { ok:false, error }（不静默吞错）。
//
// 输出约定（与 schema.output.json 对齐）：
//   - 信封：{ ok, documents, metrics }；documents[i] 符合 schema 的单文档形状——
//     成功 = ParsedDoc（docId/docName/pageCount/fullText/separator/blocks/warnings），
//     失败 = { ok:false, reason }（reason 含错误码，如 PARSE_FAILED：…）。
//   - 输出前 stripInternal：只保留 schema 白名单字段 + 该文档的解析告警 warnings；
//     cacheHit/hash/临时路径等内部字段一律剥离；全批告警（含 docid_generated）汇总进
//     metrics.warnings。
//   - docId 缺失时用文件内容 md5 生成（相同内容 → 相同 docId），并记一条告警。

import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { performance } from 'node:perf_hooks'
import { md5Hex } from './utils/block.js'
import { SkillError, toSkillError } from './utils/errors.js'
import { parseDocx } from './parsers/docx.js'
import { parsePdf } from './parsers/pdf.js'

/** 按 docName 扩展名分派解析器 */
const PARSERS_BY_EXT = { '.docx': parseDocx, '.pdf': parsePdf }
const DEFAULT_CONCURRENCY = 2

/**
 * parse-document 技能主入口。
 *
 * @param {object|null|undefined} input 支持两种形态：
 *   - 多文档：{ documents: Array<{docId?, docName, 内容四选一}>, maxConcurrency? }
 *   - 单文档：{ docId?, docName, 内容四选一, maxConcurrency? }
 *   内容四选一：path（本地文件路径）/ base64（二进制 Base64）/ contentBase64
 *   （schema.input.json 字段名，同 base64）/ text（纯文本，仅 txt/md 且当前未支持）；
 *   docId 缺失时用文件内容 md5 生成。
 * @param {{maxConcurrency?:number}} [ctx] 上下文（可在 ctx 或 input 里指定并发上限，默认 2）
 * @returns {Promise<object>}
 *   成功/部分失败：{ ok:boolean, documents:Array, metrics:{total,success,failed,durationMs,warnings} }
 *   非法输入或调度异常：{ ok:false, error:{code,message,detail} }
 */
export async function parseDocumentSkill(input, ctx = {}) {
  const started = performance.now()
  const warnings = []
  try {
    const maxConcurrency = normalizeLimit(ctx?.maxConcurrency ?? input?.maxConcurrency ?? DEFAULT_CONCURRENCY)
    const docs = validateInput(input) // 输入形状问题抛 SkillError('INVALID_INPUT')
    const results = []
    for (let i = 0; i < docs.length; i += maxConcurrency) {
      const batch = docs.slice(i, i + maxConcurrency)
      const batchOut = await Promise.all(batch.map((d) => parseOne(d, warnings)))
      results.push(...batchOut) // 顺序与输入一致
    }
    const failed = results.filter((r) => r.ok === false).length
    return {
      ok: failed === 0,
      documents: results,
      metrics: {
        total: docs.length,
        success: docs.length - failed,
        failed,
        durationMs: Math.round(performance.now() - started),
        warnings,
      },
    }
  } catch (err) {
    return { ok: false, error: toSkillError(err) }
  }
}

// ── 输入校验（纯函数；问题抛 SkillError('INVALID_INPUT')）──

function validateInput(input) {
  if (!input || typeof input !== 'object') throw new SkillError('INVALID_INPUT', 'input 必须是对象')
  let rawDocs
  if (Array.isArray(input.documents)) rawDocs = input.documents
  else if (typeof input.docName === 'string' && input.docName.trim()) rawDocs = [input]
  else throw new SkillError('INVALID_INPUT', 'input 需要 documents 数组，或单个文档对象（含 docName）')
  if (rawDocs.length === 0) throw new SkillError('INVALID_INPUT', 'documents 至少需要一个文档')
  return rawDocs.map(validateDoc)
}

function validateDoc(d, index) {
  if (!d || typeof d !== 'object') throw new SkillError('INVALID_INPUT', `documents[${index}] 必须是对象`)
  if (typeof d.docName !== 'string' || !d.docName.trim()) {
    throw new SkillError('INVALID_INPUT', `documents[${index}] 缺少 docName`)
  }
  // 内容来源兼容 schema.input.json（contentBase64/text）与阶段二约定（path/base64），四选一
  const hasPath = typeof d.path === 'string' && d.path.length > 0
  const contentRaw = d.contentBase64 ?? d.base64
  const hasBase64 = typeof contentRaw === 'string' && contentRaw.length > 0
  const hasText = typeof d.text === 'string' && d.text.length > 0
  if ([hasPath, hasBase64, hasText].filter(Boolean).length !== 1) {
    throw new SkillError('INVALID_INPUT', `documents[${index}] 的 path / base64 / contentBase64 / text 必须且只能提供一个`)
  }
  return {
    docId: typeof d.docId === 'string' && d.docId ? d.docId : null,
    docName: d.docName.trim(),
    kind: hasPath ? 'path' : 'buffer',
    path: hasPath ? d.path : null,
    buffer: hasPath ? null : hasText ? Buffer.from(d.text, 'utf8') : Buffer.from(contentRaw, 'base64'),
  }
}

function normalizeLimit(rawLimit) {
  const n = Number(rawLimit)
  if (!Number.isInteger(n) || n < 1) {
    throw new SkillError('INVALID_INPUT', `maxConcurrency 必须是 ≥1 的整数，收到：${JSON.stringify(rawLimit)}`)
  }
  return n
}

// ── 单文档解析（失败不抛出，转为 { ok:false, reason }）───

async function parseOne(doc, warnings) {
  let tempDir = null
  try {
    // 缺 docId：用文件内容 hash 生成（path 读文件，base64 用解码后的 buffer）
    let docId = doc.docId
    if (!docId) {
      const content = doc.kind === 'path' ? await readFile(doc.path) : doc.buffer
      docId = md5Hex(content)
      warnings.push({ code: 'docid_generated', docName: doc.docName, message: 'docId 缺失，已用文件内容 md5（32 位 hex）生成' })
    }

    const parser = PARSERS_BY_EXT[extname(doc.docName).toLowerCase()]
    if (!parser) {
      throw new SkillError('UNSUPPORTED_FORMAT', `暂不支持的格式：${extname(doc.docName) || '(无扩展名)'}（仅 .docx/.pdf）`)
    }

    // base64 内容需要落临时文件（两个解析器都按文件路径工作）
    let filePath = doc.path
    if (doc.kind === 'buffer') {
      tempDir = await mkdtemp(join(tmpdir(), 'archcomply-parse-'))
      filePath = join(tempDir, `${randomUUID()}.bin`)
      await writeFile(filePath, doc.buffer)
    }

    const out = await parser(filePath, { docId, docName: doc.docName })
    for (const w of out.warnings) {
      warnings.push({ code: w.code, message: w.message, docName: doc.docName })
    }
    return stripInternal(out, { docId, docName: doc.docName })
  } catch (err) {
    const se = toSkillError(err) // 保留原 code（PARSE_FAILED/READ_FAILED/OCR_REQUIRED…）
    return { ok: false, reason: `${se.code}：${se.message}` }
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 按 schema.output.json 成功分支构造输出：公开字段 + 该文档的解析告警 warnings；
 * cacheHit/hash/临时路径等内部字段一律不可能泄漏。
 */
function stripInternal(out, meta) {
  return {
    docId: meta.docId,
    docName: meta.docName,
    pageCount: out.pageCount,
    fullText: out.fullText,
    separator: '\n', // finalizeBlocks 的块间连接符（见 docs/contracts.md）
    blocks: out.blocks,
    warnings: out.warnings ?? [], // 该文档自己的解析告警；全批汇总仍见 metrics.warnings
  }
}