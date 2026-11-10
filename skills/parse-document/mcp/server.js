// skills/parse-document/mcp/server.js —— parse_document MCP stdio server
// 用 @modelcontextprotocol/sdk 暴露 stdio MCP server，tool 名 parse_document。
//
// 实现说明：SDK 1.32.1 的高层 McpServer.registerTool 只接受 Zod schema 或
// "每字段一个 Zod 类型"的 raw shape，会拒绝原生 JSON Schema 对象；而本工具的
// inputSchema 要求"读取 schema.input.json"（draft-07 原生 JSON Schema），
// 因此使用低层 Server + 手动 ListTools/CallTool 请求处理器，inputSchema 原样透传。
//
// handler 调用 parseDocumentSkill（../index.js），结果序列化为 JSON 文本返回；
// 解析失败不会抛到协议层（parseDocumentSkill 返回 { ok:false, error/reason }）。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { parseDocumentSkill } from '../index.js'

const TOOL_NAME = 'parse_document'
const TOOL_TITLE = '解析文档（docx/pdf → Block 结构）'
const TOOL_DESCRIPTION =
  '解析合同/标书文档（.docx/.pdf）为统一 Block 结构（blockId/页码/字符偏移）。' +
  '输入支持单文档对象（docName + path|base64，path 与 base64 二选一，docId 可省略）' +
  '或 documents 数组批量解析（可带 maxConcurrency）。' +
  '输出 { ok, documents, metrics }：documents[i] 严格符合 schema.output.json 的单文档形状；' +
  '解析失败不抛异常，详见返回 JSON 中的 error / reason 字段。'

// inputSchema 直接读取 ../schema.input.json（JSON Schema draft-07）
const inputSchema = JSON.parse(
  readFileSync(new URL('../schema.input.json', import.meta.url), 'utf8'),
)

const server = new Server(
  { name: 'parse-document', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: TOOL_NAME,
      title: TOOL_TITLE,
      description: TOOL_DESCRIPTION,
      inputSchema,
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  if (name !== TOOL_NAME) {
    throw new Error(`未知工具: ${name}（本服务只提供 ${TOOL_NAME}）`)
  }
  // parseDocumentSkill 自身有 validateInput 兜底，任何异常都不会抛到 JSON-RPC 层
  const result = await parseDocumentSkill(args ?? {}, {})
  return { content: [{ type: 'text', text: JSON.stringify(result) }] }
})

server.onerror = (error) => console.error('[parse_document:error]', error?.message ?? error)

const transport = new StdioServerTransport()
await server.connect(transport)