// test/parser.test.js —— 解析模块测试（node:test + node:assert/strict）
// 覆盖：utils 纯函数 / docx HTML 分类与真实 docx 集成 / pdf 行→块分组与 bbox / 主入口分派

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { md5Hex, buildBlockId, normalizeText, assignGlobalOffsets, finalizeBlocks } from '../src/rules/parser/utils.js'
import { htmlToBlocks, parseDocxBlocks } from '../src/rules/parser/docx.js'
import { textItemsToBlocks, extractPdfBlocks, parsePdfBlocks } from '../src/rules/parser/pdf.js'
import { parseDocument, parseFile, toFullText } from '../src/rules/parser/index.js'

// ── utils ───────────────────────────────────────────────

test('buildBlockId：按规格公式生成且确定', () => {
  const a = buildBlockId({ docId: 'd1', blockIndex: 3, heading: '第一条', text: '内容' })
  assert.equal(a, md5Hex('d1:3:第一条:内容'))
  assert.equal(buildBlockId({ docId: 'd1', blockIndex: 3, heading: '第一条', text: '内容' }), a)
  // heading 为 null 时按空串参与哈希
  const b = buildBlockId({ docId: 'd1', blockIndex: 3, heading: null, text: '内容' })
  assert.equal(b, md5Hex('d1:3::内容'))
  assert.notEqual(a, b)
})

test('finalizeBlocks：注入元数据、blockId、全局偏移与 fullText', () => {
  const raw = [
    { type: 'heading', heading: null, text: '第一条 报价有效期' },
    { type: 'paragraph', heading: '第一条 报价有效期', text: '报价有效期不得少于 90 天。' },
    { type: 'table', heading: '第一条 报价有效期', text: '项目 | 金额\n设备 | 100', rows: [['项目', '金额'], ['设备', '100']] },
  ]
  const { blocks, fullText, separator } = finalizeBlocks(raw, { docId: 'd1', docName: '合同.docx' })

  assert.equal(blocks.length, 3)
  assert.equal(blocks[0].docId, 'd1')
  assert.equal(blocks[0].docName, '合同.docx')
  assert.equal(blocks[0].page, null) // docx 无分页信息
  assert.equal(blocks[1].type, 'paragraph')
  assert.equal(blocks[1].heading, '第一条 报价有效期')
  assert.deepEqual(blocks[2].rows, [['项目', '金额'], ['设备', '100']])
  assert.ok(blocks[2].bbox === undefined) // docx 无 bbox

  assert.equal(separator, '\n')
  assert.equal(fullText, '第一条 报价有效期\n报价有效期不得少于 90 天。\n项目 | 金额\n设备 | 100')

  // 全局左闭右开偏移
  assert.equal(blocks[0].charStart, 0)
  assert.equal(blocks[0].charEnd, '第一条 报价有效期'.length)
  assert.equal(blocks[1].charStart, '第一条 报价有效期'.length + 1)
  assert.equal(blocks[1].charEnd, blocks[1].charStart + '报价有效期不得少于 90 天。'.length)
  assert.equal(blocks[2].charEnd, fullText.length)
})

test('normalizeText：统一换行与 NBSP', () => {
  assert.equal(normalizeText('a\r\nb'), 'a\nb')
  assert.equal(normalizeText('  x\u00a0y  '), 'x y')
})

test('assignGlobalOffsets：自定义分隔符', () => {
  const blocks = [{ text: 'aa' }, { text: 'bb' }]
  const { fullText } = assignGlobalOffsets(blocks, '|')
  assert.equal(fullText, 'aa|bb')
  assert.equal(blocks[1].charStart, 3)
})

// ── docx（HTML 分类，纯函数）────────────────────────────

test('htmlToBlocks：heading/paragraph/list_item/table 分类与归属', () => {
  const html = `
    <h1>第一条 报价有效期</h1>
    <p>报价有效期不得少于 90 天。</p>
    <ul><li>质保期内免费维修</li><li>质保期不少于 12 个月</li></ul>
    <table>
      <tr><td>项目</td><td>金额</td></tr>
      <tr><td>设备</td><td>100 万</td></tr>
    </table>
  `
  const blocks = htmlToBlocks(html)
  assert.deepEqual(blocks.map((b) => b.type), [
    'heading', 'paragraph', 'list_item', 'list_item', 'table', 'table_cell', 'table_cell', 'table_cell', 'table_cell',
  ])
  assert.equal(blocks[0].text, '第一条 报价有效期')
  assert.equal(blocks[1].heading, '第一条 报价有效期')
  assert.equal(blocks[2].heading, '第一条 报价有效期')

  const table = blocks[4]
  assert.deepEqual(table.rows, [['项目', '金额'], ['设备', '100 万']])
  assert.equal(table.text, '项目 | 金额\n设备 | 100 万')
  assert.equal(blocks[5].type, 'table_cell')
  assert.equal(blocks[5].text, '项目')
})

test('htmlToBlocks：空 HTML 抛错', () => {
  assert.throws(() => htmlToBlocks('<p>   </p>'), /未解析出任何 block/)
})

// ── docx（真实最小 docx 集成：验证 mammoth API 用法）──────

test('parseDocxBlocks：最小 docx 端到端', async () => {
  const buffer = buildMinimalDocx()
  const blocks = await parseDocxBlocks({ buffer })
  assert.ok(blocks.length >= 6)
  assert.equal(blocks[0].type, 'heading') // Heading1 → h1
  assert.equal(blocks[0].text, '第一条 报价有效期')
  const table = blocks.find((b) => b.type === 'table')
  assert.ok(table, '应有 table 块')
  assert.deepEqual(table.rows, [['项目', '金额'], ['设备', '100']])
})

// ── pdf（行 → 块分组，纯函数）───────────────────────────

test('textItemsToBlocks：行拼接、补空格、段落断块、标题与列表检测、bbox', () => {
  const items = [
    { str: '合同条款', transform: [1, 0, 0, 1, 50, 700], width: 60, height: 20, hasEOL: true },   // 大字号 → heading
    { str: '报价有效期不得少于', transform: [1, 0, 0, 1, 50, 650], width: 100, height: 10, hasEOL: true }, // 段落第一行
    { str: '90 天。', transform: [1, 0, 0, 1, 50, 636], width: 40, height: 10, hasEOL: true },            // 同行接续（中文，不补空格）
    { str: 'Payment', transform: [1, 0, 0, 1, 50, 620], width: 50, height: 10, hasEOL: false },
    { str: 'Terms', transform: [1, 0, 0, 1, 110, 620], width: 40, height: 10, hasEOL: true },             // 水平间隙 → 补空格
    { str: '1. 交付要求', transform: [1, 0, 0, 1, 50, 560], width: 80, height: 10, hasEOL: true },        // 序号 → list_item
  ]
  const blocks = textItemsToBlocks(items, 1)
  assert.equal(blocks[0].type, 'heading')
  assert.equal(blocks[0].text, '合同条款')
  assert.equal(blocks[0].page, 1)
  assert.ok(blocks[0].bbox && blocks[0].bbox.x0 === 50 && blocks[0].bbox.x1 === 110)

  const p1 = blocks[1]
  assert.equal(p1.type, 'paragraph')
  assert.equal(p1.text, '报价有效期不得少于90 天。') // 中文接缝不补空格，'90 天'内部保留
  assert.equal(blocks[2].type, 'paragraph')
  assert.equal(blocks[2].text, 'Payment Terms') // 英文水平间隙补空格
  assert.equal(blocks[3].type, 'list_item')
})

test('textItemsToBlocks：垂直大间隙断段 + 空白项跳过', () => {
  const items = [
    { str: '第一段内容', transform: [1, 0, 0, 1, 50, 700], width: 80, height: 10, hasEOL: true },
    { str: '   ', transform: [1, 0, 0, 1, 50, 680], width: 0, height: 10, hasEOL: true }, // 空白项应被跳过
    { str: '第二段内容', transform: [1, 0, 0, 1, 50, 580], width: 80, height: 10, hasEOL: true },
  ]
  const blocks = textItemsToBlocks(items, 1)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].text, '第一段内容')
  assert.equal(blocks[1].text, '第二段内容')
})

// ── pdf（extractPdfBlocks 可注入 doc，纯逻辑测试）────────

test('extractPdfBlocks：注入假 PDF 代理，页码逐页递增', async () => {
  const fakeDoc = {
    numPages: 2,
    getPage: async (n) => ({
      getTextContent: async () => ({
        items: [{ str: `第 ${n} 页内容`, transform: [1, 0, 0, 1, 50, 700], width: 80, height: 10, hasEOL: true }],
      }),
    }),
  }
  const blocks = await extractPdfBlocks(fakeDoc)
  assert.deepEqual(blocks.map((b) => b.page), [1, 2])
  assert.equal(blocks[0].text, '第 1 页内容')
  assert.ok(blocks[1].bbox)
})

test('parsePdfBlocks：非法 buffer 抛带上下文错误', async () => {
  await assert.rejects(
    parsePdfBlocks({ buffer: Buffer.from('这根本不是 PDF 内容 '.repeat(20)) }),
    (err) => err instanceof Error && /pdf/i.test(err.message),
  )
})

// ── 主入口 ──────────────────────────────────────────────

test('parseDocument：txt 按空行切段 + 全局偏移 + pageCount=0', async () => {
  const parsed = await parseDocument({
    docId: 'txt-1', docName: '样本.txt',
    buffer: Buffer.from('第一段内容。\n\n第二段内容。\n第三段内容。'),
  })
  assert.equal(parsed.docName, '样本.txt')
  assert.equal(parsed.pageCount, 0)
  assert.equal(parsed.blocks.length, 2)
  assert.deepEqual(parsed.blocks.map((b) => b.type), ['paragraph', 'paragraph'])
  assert.equal(parsed.fullText, '第一段内容。\n第二段内容。\n第三段内容。')
  assert.equal(parsed.blocks[0].charEnd, '第一段内容。'.length)
  assert.equal(parsed.blocks[1].charStart, '第一段内容。'.length + 1)
  assert.ok(/^[0-9a-f]{32}$/.test(parsed.blocks[0].blockId))
  assert.equal(toFullText(parsed), parsed.fullText)
})

test('parseDocument：docx 端到端 + 页码为 null', async () => {
  const parsed = await parseDocument({ docId: 'docx-1', docName: '合同.docx', buffer: buildMinimalDocx() })
  assert.equal(parsed.pageCount, 0)
  assert.ok(parsed.blocks.every((b) => b.page === null))
  assert.equal(parsed.blocks[0].type, 'heading')
  assert.ok(parsed.blocks.some((b) => b.type === 'table_cell'))
  assert.ok(parsed.fullText.includes('报价有效期不得少于 90 天。'))
})

test('parseDocument：不支持的格式抛错', async () => {
  await assert.rejects(
    parseDocument({ docName: 'x.xls', buffer: Buffer.from('x') }),
    /暂不支持的格式/,
  )
})

test('parseFile：读本地文件解析（txt）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'archcomply-'))
  const file = join(dir, '条款.txt')
  await writeFile(file, '第一条 质保期。\n质保期不少于 12 个月。')
  try {
    const parsed = await parseFile(file)
    assert.equal(parsed.docName, '条款.txt')
    assert.equal(parsed.blocks.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── 测试辅助：手工构造最小 docx（stored zip）────────────

const DOC_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一条 报价有效期</w:t></w:r></w:p>
    <w:p><w:r><w:t>报价有效期不得少于 90 天。</w:t></w:r></w:p>
    <w:p><w:r><w:t>第二条 付款方式</w:t></w:r></w:p>
    <w:p><w:r><w:t>预付款比例不得高于 30%。</w:t></w:r></w:p>
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

function buildMinimalDocx() {
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
