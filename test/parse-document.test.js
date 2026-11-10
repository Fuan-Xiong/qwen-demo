// test/parse-document.test.js —— parse-document 技能 utils 测试（node:test + node:assert/strict）
// 覆盖：blockId 稳定/区分度、fullText 偏移与 slice 反校验、normalize 中文、finalizeBlocks 告警、SkillError

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  md5Hex, makeBlockId, buildFullText, normalizeText, finalizeBlocks,
} from '../skills/parse-document/utils/block.js'
import { SkillError, toSkillError } from '../skills/parse-document/utils/errors.js'
import { parseDocx } from '../skills/parse-document/parsers/docx.js'
import { parsePdf } from '../skills/parse-document/parsers/pdf.js'
import { parseDocumentSkill } from '../skills/parse-document/index.js'

// ── md5Hex / makeBlockId ───────────────────────────────

test('md5Hex：标准向量', () => {
  assert.equal(md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72')
})

test('makeBlockId：稳定且符合规格公式', () => {
  const a = makeBlockId({ docId: 'd1', blockIndex: 3, heading: '第一条', text: '内容' })
  assert.equal(a, md5Hex('d1:3:第一条:内容'))
  // 同一输入两次 → 同一 ID（幂等）
  assert.equal(makeBlockId({ docId: 'd1', blockIndex: 3, heading: '第一条', text: '内容' }), a)
  // heading 为 null 时按空串参与哈希
  assert.equal(makeBlockId({ docId: 'd1', blockIndex: 3, heading: null, text: '内容' }), md5Hex('d1:3::内容'))
})

test('makeBlockId：不同文本/标题/文档/序号 → 不同 ID', () => {
  const base = { docId: 'd1', blockIndex: 1, heading: 'H', text: 'T' }
  const ids = new Set([
    makeBlockId(base),
    makeBlockId({ ...base, text: 'T2' }),
    makeBlockId({ ...base, heading: 'H2' }),
    makeBlockId({ ...base, docId: 'd2' }),
    makeBlockId({ ...base, blockIndex: 2 }),
  ])
  assert.equal(ids.size, 5)
})

// ── buildFullText ──────────────────────────────────────

test('buildFullText：偏移计算 + slice 反校验 + 自定义分隔符', () => {
  const blocks = [
    { text: '第一条 报价有效期' },
    { text: '报价有效期不得少于 90 天。' },
    { text: '预付款比例不得高于 30%。' },
  ]
  const { fullText, separator } = buildFullText(blocks)
  assert.equal(separator, '\n')
  assert.equal(fullText, blocks.map((b) => b.text).join('\n'))
  // 反校验：每个块都能用 charStart/charEnd 从 fullText 切片还原出原文本
  for (const b of blocks) assert.equal(fullText.slice(b.charStart, b.charEnd), b.text)
  assert.equal(blocks[1].charStart, blocks[0].text.length + 1)
  assert.equal(blocks[1].charEnd, blocks[1].charStart + blocks[1].text.length)
  assert.equal(blocks[2].charEnd, fullText.length)

  // 自定义分隔符
  const sep = [{ text: 'aa' }, { text: 'bb' }]
  const { fullText: ft2 } = buildFullText(sep, '|')
  assert.equal(ft2, 'aa|bb')
  assert.equal(sep[1].charStart, 3)
})

test('buildFullText：缺 text 抛 SkillError(INVALID_BLOCKS)', () => {
  assert.throws(
    () => buildFullText([{ text: 'a' }, {}]),
    (e) => e instanceof SkillError && e.code === 'INVALID_BLOCKS',
  )
})

// ── normalizeText ──────────────────────────────────────

test('normalizeText：统一换行/NBSP，不破坏中文', () => {
  const out = normalizeText('  报价\u00a0有效期不得少于\r\n90 天。  ')
  assert.equal(out, '报价 有效期不得少于\n90 天。')
  // 中文字符不被增删改：去掉空白后与原文逐字一致（NBSP 转空格是设计行为）
  assert.equal(out.replace(/\s+/g, ''), '报价有效期不得少于90天。')
  // 无空白的中文原样保留，含常见中文标点
  assert.equal(normalizeText('报价有效期不得少于90天'), '报价有效期不得少于90天')
  assert.equal(normalizeText('预付款比例不得高于30%。'), '预付款比例不得高于30%。')
})

// ── finalizeBlocks ─────────────────────────────────────

test('finalizeBlocks：统一补 blockId/偏移/fullText/元数据', () => {
  const raw = [
    { type: 'heading', heading: null, text: '第一条 报价有效期' },
    { type: 'paragraph', heading: '第一条 报价有效期', text: '报价有效期不得少于 90 天。' },
  ]
  const { blocks, fullText, separator, pageCount, warnings } = finalizeBlocks(raw, {
    docId: 'd1', docName: 'x.docx', fileType: 'docx', pageCount: 0,
  })
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].blockId, md5Hex('d1:0::第一条 报价有效期'))
  assert.equal(blocks[1].blockId, md5Hex('d1:1:第一条 报价有效期:报价有效期不得少于 90 天。'))
  assert.equal(blocks[0].docId, 'd1')
  assert.equal(blocks[0].docName, 'x.docx')
  assert.equal(blocks[0].page, null)
  assert.equal(blocks[1].heading, '第一条 报价有效期')
  assert.equal(separator, '\n')
  assert.equal(pageCount, 0)
  assert.deepEqual(warnings, [])
  assert.equal(fullText, '第一条 报价有效期\n报价有效期不得少于 90 天。')
  assert.equal(fullText.slice(blocks[1].charStart, blocks[1].charEnd), blocks[1].text)
})

test('finalizeBlocks：空块被忽略并告警，blockId 序号按最终列表连续', () => {
  const raw = [
    { type: 'heading', heading: null, text: '   ' }, // 空块 → 忽略
    { type: 'heading', heading: null, text: '第一条 报价有效期' },
    { type: 'paragraph', heading: '第一条 报价有效期', text: '报价有效期不得少于 90 天。' },
  ]
  const { blocks, warnings } = finalizeBlocks(raw, {
    docId: 'd1', docName: 'x.docx', fileType: 'docx', pageCount: 0,
  })
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].blockId, md5Hex('d1:0::第一条 报价有效期'))
  assert.deepEqual(warnings, [{ code: 'dropped_empty_blocks', count: 1, message: '忽略 1 个空文本块' }])
})

test('finalizeBlocks：pdf 缺页 / 页码越界告警', () => {
  const raw = [
    { type: 'paragraph', heading: null, text: '无页码', page: null },
    { type: 'paragraph', heading: null, text: '越界', page: 5 },
    { type: 'paragraph', heading: null, text: '正常', page: 2 },
  ]
  const { blocks, warnings } = finalizeBlocks(raw, {
    docId: 'd1', docName: 'p.pdf', fileType: 'pdf', pageCount: 3,
  })
  assert.equal(blocks.length, 3)
  const codes = warnings.map((w) => w.code)
  assert.ok(codes.includes('missing_page'))
  assert.ok(codes.includes('page_out_of_range'))
  assert.equal(warnings.find((w) => w.code === 'missing_page').blockIndex, 0)
  assert.equal(warnings.find((w) => w.code === 'page_out_of_range').page, 5)
  assert.equal(blocks[0].page, null)
  assert.equal(blocks[1].page, 5)
})

test('finalizeBlocks：空结果抛 EMPTY_RESULT；元数据缺失抛 INVALID_META', () => {
  assert.throws(
    () => finalizeBlocks([{ type: 'paragraph', text: '   ' }], { docId: 'd1', docName: 'x', fileType: 'txt', pageCount: 0 }),
    (e) => e instanceof SkillError && e.code === 'EMPTY_RESULT',
  )
  assert.throws(
    () => finalizeBlocks([{ type: 'paragraph', text: 'a' }], { docId: '', docName: 'x', fileType: 'txt', pageCount: 0 }),
    (e) => e instanceof SkillError && e.code === 'INVALID_META',
  )
})

// ── errors.js ──────────────────────────────────────────

test('SkillError：code/message/detail 与 instanceof', () => {
  const e = new SkillError('PARSE_FAILED', '解析失败', { docName: 'x.pdf' })
  assert.ok(e instanceof Error)
  assert.ok(e instanceof SkillError)
  assert.equal(e.name, 'SkillError')
  assert.equal(e.code, 'PARSE_FAILED')
  assert.equal(e.message, '解析失败')
  assert.deepEqual(e.detail, { docName: 'x.pdf' })
})

test('toSkillError：透传 SkillError；包装普通错误并保留 code', () => {
  // 已是 SkillError → 原样返回
  const se = new SkillError('EMPTY_RESULT', '空')
  assert.equal(toSkillError(se), se)

  // 普通 Error → 包装为 SkillError(UNKNOWN)，detail 记录原始信息
  const plain = toSkillError(new Error('boom'))
  assert.ok(plain instanceof SkillError)
  assert.equal(plain.code, 'UNKNOWN')
  assert.equal(plain.detail.originalName, 'Error')
  assert.equal(plain.detail.originalMessage, 'boom')
  assert.equal(plain.cause.message, 'boom')

  // 带 code 的错误 → 默认保留原 code
  const coded = toSkillError(Object.assign(new Error('bad'), { code: 'BadRequest' }))
  assert.equal(coded.code, 'BadRequest')

  // forceCode: true → 强制 fallbackCode，原 code 保留在 detail.originalCode
  const forced = toSkillError(Object.assign(new Error('missing'), { code: 'ENOENT' }), 'READ_FAILED', { forceCode: true })
  assert.equal(forced.code, 'READ_FAILED')
  assert.equal(forced.detail.originalCode, 'ENOENT')
  assert.ok(forced.cause instanceof Error)
})

// ── docx 解析器（skills/parse-document/parsers/docx.js）──

test('parseDocx：标题/段落/表格端到端，rows 二维数组，偏移正确', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'archcomply-skill-docx-'))
  const file = join(dir, '合同.docx')
  await writeFile(file, buildDocxFixture())
  try {
    const parsed = await parseDocx(file, { docId: 'd1', docName: '合同.docx' })

    // 类型序列：heading + paragraph + table + 4 个 table_cell；两个空段落被跳过
    assert.deepEqual(parsed.blocks.map((b) => b.type), [
      'heading', 'paragraph', 'table', 'table_cell', 'table_cell', 'table_cell', 'table_cell',
    ])

    // rows 是二维数组
    const table = parsed.blocks.find((b) => b.type === 'table')
    assert.ok(Array.isArray(table.rows))
    assert.ok(table.rows.length > 0)
    assert.ok(table.rows.every((r) => Array.isArray(r) && r.every((c) => typeof c === 'string')))
    assert.deepEqual(table.rows, [['项目', '金额'], ['设备', '100']])

    // heading 向后继承
    assert.equal(parsed.blocks[1].heading, '第一条 报价有效期')
    assert.equal(table.heading, '第一条 报价有效期')

    // 偏移正确：每个 block 都能用 charStart/charEnd 从 fullText 切片还原
    for (const b of parsed.blocks) {
      assert.equal(parsed.fullText.slice(b.charStart, b.charEnd), b.text, `block ${b.blockId}`)
    }
    assert.equal(parsed.blocks.at(-1).charEnd, parsed.fullText.length)
    // 相邻块偏移无重叠、continuity
    for (let i = 1; i < parsed.blocks.length; i += 1) {
      assert.equal(parsed.blocks[i].charStart, parsed.blocks[i - 1].charEnd + 1)
    }

    // page 一律 null + warning；pageCount=0
    assert.ok(parsed.blocks.every((b) => b.page === null))
    assert.equal(parsed.pageCount, 0)
    assert.ok(parsed.warnings.some((w) => w.code === 'no_page_info'))

    // blockId 为 32 位 md5
    assert.ok(parsed.blocks.every((b) => /^[0-9a-f]{32}$/.test(b.blockId)))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('parseDocx：文件不存在抛 SkillError(READ_FAILED)，空 filePath 抛 INVALID_INPUT', async () => {
  await assert.rejects(
    parseDocx(join(tmpdir(), '不存在的文件.docx'), { docId: 'd1', docName: 'x.docx' }),
    (e) => e instanceof SkillError && e.code === 'READ_FAILED',
  )
  await assert.rejects(
    parseDocx('', { docId: 'd1', docName: 'x.docx' }),
    (e) => e instanceof SkillError && e.code === 'INVALID_INPUT',
  )
})

// ── 测试辅助：手工构造最小 docx（stored zip，含标题/空段落/段落/表格）──

const DOC_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一条 报价有效期</w:t></w:r></w:p>
    <w:p/>
    <w:p><w:r><w:t>报价有效期不得少于 90 天。</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>设备</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>100</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p/>
    <w:sectPr/>
  </w:body>
</w:document>`

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

function buildDocxFixture() {
  return zipStore([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES) },
    { name: '_rels/.rels', data: Buffer.from(RELS) },
    { name: 'word/document.xml', data: Buffer.from(DOC_XML) },
  ])
}

/** 手工构造只含 stored（不压缩）条目的 zip，够 mammoth/jszip 读取 */
function zipStore(files) {
  const parts = []
  const central = []
  let offset = 0
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8')
    const crc = crc32(f.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // method: stored
    local.writeUInt16LE(0, 10) // mod time
    local.writeUInt16LE(0, 12) // mod date
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(f.data.length, 18)
    local.writeUInt32LE(f.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra len
    parts.push(local, nameBuf, f.data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0) // central directory header
    cd.writeUInt16LE(20, 4) // version made by
    cd.writeUInt16LE(20, 6) // version needed
    cd.writeUInt16LE(0, 8) // flags
    cd.writeUInt16LE(0, 10) // method
    cd.writeUInt16LE(0, 12) // time
    cd.writeUInt16LE(0, 14) // date
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(f.data.length, 20)
    cd.writeUInt32LE(f.data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30) // extra len
    cd.writeUInt16LE(0, 32) // comment len
    cd.writeUInt16LE(0, 34) // disk start
    cd.writeUInt16LE(0, 36) // internal attrs
    cd.writeUInt32LE(0, 38) // external attrs
    cd.writeUInt32LE(offset, 42) // local header offset
    central.push(cd, nameBuf)
    offset += 30 + nameBuf.length + f.data.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // end of central directory
  eocd.writeUInt16LE(0, 4) // disk number
  eocd.writeUInt16LE(0, 6) // disk with cd
  eocd.writeUInt16LE(files.length, 8) // entries on this disk
  eocd.writeUInt16LE(files.length, 10) // total entries
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // comment len
  return Buffer.concat([...parts, centralBuf, eocd])
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ── pdf 解析器（skills/parse-document/parsers/pdf.js）────

test('parsePdf：多页 PDF，page 正确、bbox 存在、偏移正确', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'archcomply-skill-pdf-'))
  const file = join(dir, '合同.pdf')
  await writeFile(file, buildPdf([
    { lines: [
      { x: 50, y: 700, size: 18, text: 'Offer Validity' },
      { x: 50, y: 686, size: 12, text: 'Valid for 90 days from signing' },
    ] },
    { lines: [
      { x: 50, y: 700, size: 12, text: 'Payment terms: 30 days net' },
      { x: 50, y: 686, size: 12, text: 'Late payment penalty 1 percent' },
    ] },
  ]))
  try {
    const parsed = await parsePdf(file, { docId: 'd1', docName: '合同.pdf' })

    // page 1-based 且逐页正确
    assert.equal(parsed.pageCount, 2)
    assert.deepEqual(parsed.blocks.map((b) => b.page), [1, 1, 2])
    // 标题检测（18pt > 12pt 中位×1.18）与段落合并
    assert.deepEqual(parsed.blocks.map((b) => b.type), ['heading', 'paragraph', 'paragraph'])
    assert.equal(parsed.blocks[0].text, 'Offer Validity')
    assert.equal(parsed.blocks[1].text, 'Valid for 90 days from signing')
    assert.equal(parsed.blocks[2].text, 'Payment terms: 30 days net Late payment penalty 1 percent')
    assert.equal(parsed.blocks[0].heading, null)

    // bbox 存在且 x0 与书写位置一致（约 50）
    for (const b of parsed.blocks) {
      assert.ok(b.bbox, 'block 应带 bbox')
      const { x0, top, x1, bottom } = b.bbox
      assert.ok([x0, top, x1, bottom].every((n) => typeof n === 'number' && Number.isFinite(n)))
      assert.ok(Math.abs(x0 - 50) < 2)
      assert.ok(x1 > x0)
      assert.ok(top > bottom) // PDF y 向上：top 是较大 y
    }

    // 偏移正确：每个 block 都能从 fullText 切片还原，末块 charEnd = 全文长度
    for (const b of parsed.blocks) assert.equal(parsed.fullText.slice(b.charStart, b.charEnd), b.text)
    assert.equal(parsed.blocks.at(-1).charEnd, parsed.fullText.length)
    assert.ok(parsed.blocks.every((b) => /^[0-9a-f]{32}$/.test(b.blockId)))

    // 结构正常：无告警
    assert.deepEqual(parsed.warnings, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('parsePdf：includeBbox=false 时不输出 bbox', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'archcomply-skill-pdf-'))
  const file = join(dir, 'nobbox.pdf')
  await writeFile(file, buildPdf([{ lines: [{ x: 50, y: 700, size: 12, text: 'No bbox output' }] }]))
  try {
    const parsed = await parsePdf(file, { docId: 'd1', docName: 'nobbox.pdf', includeBbox: false })
    assert.ok(parsed.blocks.length > 0)
    assert.ok(parsed.blocks.every((b) => !('bbox' in b)))
    assert.equal(parsed.blocks[0].text, 'No bbox output')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('parsePdf：扫描版（无文本层）抛 OCR_REQUIRED', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'archcomply-skill-pdf-'))
  const file = join(dir, '扫描件.pdf')
  await writeFile(file, buildPdf([{ lines: [] }, { lines: [] }]))
  try {
    await assert.rejects(
      parsePdf(file, { docId: 'd1', docName: '扫描件.pdf' }),
      (e) => e instanceof SkillError && e.code === 'OCR_REQUIRED',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('parsePdf：多栏布局加 warning 并按列拆分', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'archcomply-skill-pdf-'))
  const file = join(dir, '双栏.pdf')
  await writeFile(file, buildPdf([{ lines: [
    { x: 50, y: 700, size: 12, text: 'Column A first line' },
    { x: 400, y: 700, size: 12, text: 'Column B first line' },
    { x: 50, y: 686, size: 12, text: 'Column A second line' },
  ] }]))
  try {
    const parsed = await parsePdf(file, { docId: 'd1', docName: '双栏.pdf' })
    assert.ok(parsed.warnings.some((w) => w.code === 'multi_column' && w.pages.includes(1)))
    const texts = parsed.blocks.map((b) => b.text)
    // 左右栏内容不得互相拼接，各自成块
    assert.ok(texts.includes('Column A first line'))
    assert.ok(texts.includes('Column B first line'))
    assert.ok(texts.some((t) => t.startsWith('Column A second line')))
    assert.ok(!texts.some((t) => t.includes('Column A') && t.includes('Column B') && !t.startsWith('Column B')))
    assert.equal(parsed.blocks.at(-1).charEnd, parsed.fullText.length)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('parsePdf：文件不存在抛 READ_FAILED，空 filePath 抛 INVALID_INPUT', async () => {
  await assert.rejects(
    parsePdf(join(tmpdir(), '不存在.pdf'), { docId: 'd1', docName: 'x.pdf' }),
    (e) => e instanceof SkillError && e.code === 'READ_FAILED',
  )
  await assert.rejects(
    parsePdf('', { docId: 'd1', docName: 'x.pdf' }),
    (e) => e instanceof SkillError && e.code === 'INVALID_INPUT',
  )
})

// ── 测试辅助：手工构造最小 PDF（Helvetica 文本，坐标可控）──

/**
 * @param {Array<{lines:Array<{x:number, y:number, size:number, text:string}>}>} pages
 * @returns {Buffer} 合法 PDF 字节
 */
function buildPdf(pages) {
  const N = pages.length
  const fontId = 3 + 2 * N
  const bodies = []
  // 1: catalog，2: pages
  bodies.push('<< /Type /Catalog /Pages 2 0 R >>')
  bodies.push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i} 0 R`).join(' ')}] /Count ${N} >>`)
  // 页面对象
  pages.forEach((_pg, i) => {
    const pageId = 3 + i
    const contentId = 3 + N + i
    bodies.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`)
  })
  // 内容流：每行一个绝对定位的 Tj
  pages.forEach((pg) => {
    const stream = pg.lines.map((l) => `BT /F1 ${l.size} Tf 1 0 0 1 ${l.x} ${l.y} Tm (${l.text}) Tj ET`).join('\n')
    bodies.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`)
  })
  // 标准字体（无需嵌入）
  bodies.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  return assemblePdf(bodies)
}

/** 按对象体列表序列化 PDF（计算 xref 偏移） */
function assemblePdf(bodies) {
  const chunks = ['%PDF-1.4\n']
  const offsets = []
  bodies.forEach((body, i) => {
    offsets.push(Buffer.byteLength(chunks.join(''), 'latin1'))
    chunks.push(`${i + 1} 0 obj\n${body}\nendobj\n`)
  })
  const xrefOffset = Buffer.byteLength(chunks.join(''), 'latin1')
  chunks.push(`xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`)
  for (const off of offsets) chunks.push(`${String(off).padStart(10, '0')} 00000 n \n`)
  chunks.push(`trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`)
  return Buffer.from(chunks.join(''), 'latin1')
}

// ── 主入口（skills/parse-document/index.js）─────────────

test('parseDocumentSkill：单文档（base64），输出严格符合 schema 单文档形状', async () => {
  const res = await parseDocumentSkill({
    documents: [{ docId: 'doc-1', docName: '合同.docx', base64: buildDocxFixture().toString('base64') }],
  })
  assert.equal(res.ok, true)
  assert.equal(res.documents.length, 1)

  const d = res.documents[0]
  // 严格 schema 形状：只允许成功分支的 7 个字段（cacheHit 等内部字段不得泄漏）
  assert.deepEqual(Object.keys(d).sort(), ['blocks', 'docId', 'docName', 'fullText', 'pageCount', 'separator', 'warnings'])
  assert.ok(Array.isArray(d.warnings))
  assert.equal(d.docId, 'doc-1')
  assert.equal(d.docName, '合同.docx')
  assert.equal(d.pageCount, 0)
  assert.equal(d.separator, '\n')
  assert.ok(Array.isArray(d.blocks) && d.blocks.length > 0)
  // 块数据完整且偏移正确
  for (const b of d.blocks) assert.equal(d.fullText.slice(b.charStart, b.charEnd), b.text)
  assert.equal(d.blocks.at(-1).charEnd, d.fullText.length)
  // blocks 内的 docId 与顶层一致
  assert.ok(d.blocks.every((b) => b.docId === 'doc-1'))
  // metrics
  assert.deepEqual(Object.keys(res.metrics).sort(), ['durationMs', 'failed', 'success', 'total', 'warnings'])
  assert.equal(res.metrics.total, 1)
  assert.equal(res.metrics.success, 1)
  assert.equal(res.metrics.failed, 0)
  assert.ok(res.metrics.durationMs >= 0)
  assert.ok(Array.isArray(res.metrics.warnings))
})

test('parseDocumentSkill：多文档顺序稳定（path+base64 混用，并发 2）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'archcomply-skill-entry-'))
  const docxPath = join(dir, 'c.docx')
  await writeFile(docxPath, buildDocxFixture())
  try {
    const res = await parseDocumentSkill({
      maxConcurrency: 2,
      documents: [
        { docId: 'a', docName: 'a.docx', base64: buildDocxFixture().toString('base64') },
        { docId: 'b', docName: 'b.pdf', base64: buildPdf([{ lines: [{ x: 50, y: 700, size: 12, text: 'Page one line' }] }]).toString('base64') },
        { docId: 'c', docName: 'c.docx', path: docxPath },
      ],
    })
    assert.equal(res.ok, true)
    // 结果与输入顺序严格一致
    assert.deepEqual(res.documents.map((x) => x.docId), ['a', 'b', 'c'])
    assert.deepEqual(res.documents.map((x) => x.docName), ['a.docx', 'b.pdf', 'c.docx'])
    // pdf 块带页码与 bbox
    assert.equal(res.documents[1].pageCount, 1)
    assert.equal(res.documents[1].blocks[0].page, 1)
    assert.ok(res.documents[1].blocks[0].bbox)
    assert.equal(res.metrics.total, 3)
    assert.equal(res.metrics.success, 3)
    assert.equal(res.metrics.failed, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('parseDocumentSkill：缺 docId 自动生成（文件内容 md5）并加 warning', async () => {
  const res = await parseDocumentSkill({ docName: 'x.docx', base64: buildDocxFixture().toString('base64') })
  assert.equal(res.ok, true)
  const d = res.documents[0]
  assert.ok(/^[0-9a-f]{32}$/.test(d.docId), `docId 应为 32 位 hex，收到：${d.docId}`)
  assert.equal(d.blocks[0].docId, d.docId) // blocks 与顶层共用同一 docId
  assert.ok(res.metrics.warnings.some((w) => w.code === 'docid_generated' && w.docName === 'x.docx'))
  assert.ok(res.metrics.warnings.some((w) => w.code === 'no_page_info')) // 解析器 warnings 也汇总进来
})

test('parseDocumentSkill：非法输入返回 INVALID_INPUT', async () => {
  // null 输入
  let res = await parseDocumentSkill(null)
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'INVALID_INPUT')
  // 空 documents
  res = await parseDocumentSkill({ documents: [] })
  assert.equal(res.error.code, 'INVALID_INPUT')
  // path 与 base64 同时提供（二选一）
  res = await parseDocumentSkill({ documents: [{ docName: 'a.docx', path: '/x/a.docx', base64: 'eHh4' }] })
  assert.equal(res.error.code, 'INVALID_INPUT')
  // 缺 docName
  res = await parseDocumentSkill({ documents: [{ base64: 'eHh4' }] })
  assert.equal(res.error.code, 'INVALID_INPUT')
  // maxConcurrency 非法
  res = await parseDocumentSkill({ documents: [{ docName: 'a.docx', base64: 'eHh4' }], maxConcurrency: 0 })
  assert.equal(res.error.code, 'INVALID_INPUT')
})

test('parseDocumentSkill：损坏文件返回 PARSE_FAILED（按文档失败，不中断其他文档）', async () => {
  const res = await parseDocumentSkill({
    documents: [
      { docId: 'bad', docName: '坏文件.docx', base64: Buffer.from('这根本不是 docx 文件 '.repeat(5)).toString('base64') },
      { docId: 'good', docName: '好文件.docx', base64: buildDocxFixture().toString('base64') },
    ],
  })
  assert.equal(res.ok, false) // 有失败文档 → 信封 ok=false
  assert.equal(res.documents[0].ok, false)
  assert.match(res.documents[0].reason, /PARSE_FAILED/)
  // 其他文档照常成功
  assert.equal(res.documents[1].docId, 'good')
  assert.equal(res.documents[1].fullText.slice(res.documents[1].blocks[0].charStart, res.documents[1].blocks[0].charEnd), res.documents[1].blocks[0].text)
  assert.equal(res.metrics.total, 2)
  assert.equal(res.metrics.success, 1)
  assert.equal(res.metrics.failed, 1)
})

test('parseDocumentSkill：兼容 schema.input.json 字段（contentBase64/text）', async () => {
  // contentBase64（schema.input.json 字段名）应等价于 base64
  const res1 = await parseDocumentSkill({
    documents: [{ docId: 's1', docName: 's.docx', contentBase64: buildDocxFixture().toString('base64') }],
  })
  assert.equal(res1.ok, true)
  assert.equal(res1.documents[0].docId, 's1')
  assert.equal(res1.documents[0].blocks[0].docId, 's1')

  // text（schema.input.json 字段）可被接受，但 txt/md 格式在入口未注册 → 按文档失败 UNSUPPORTED_FORMAT
  const res2 = await parseDocumentSkill({ documents: [{ docId: 's2', docName: 's.txt', text: '报价有效期不得少于 90 天。' }] })
  assert.equal(res2.ok, false)
  assert.equal(res2.documents[0].ok, false)
  assert.match(res2.documents[0].reason, /UNSUPPORTED_FORMAT/)
  assert.equal(res2.metrics.failed, 1)

  // 多个内容来源同时提供 → INVALID_INPUT（四选一）
  const res3 = await parseDocumentSkill({ documents: [{ docName: 'a.docx', path: '/x', contentBase64: 'eA==' }] })
  assert.equal(res3.error.code, 'INVALID_INPUT')
})
