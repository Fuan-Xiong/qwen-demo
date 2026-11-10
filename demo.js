import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stdout } from 'node:process'
import { query } from '@qwen-code/sdk'
import pc from 'picocolors'

// 自动加载项目根 .env（若存在），避免硬编码密钥入库；密钥只在本地 .env 提供
try {
  process.loadEnvFile()
} catch {
  // .env 不存在时走下方默认值（无 key 将 401，属预期）
}

// 指定工作目录为当前目录
const workdir = import.meta.dirname
const qwenDir = join(workdir, '.qwen')
const settingsPath = join(qwenDir, 'settings.json')
// 配置大模型（key 从环境变量读取，禁止明文提交到仓库）
const env = {
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  OPENAI_MODEL: process.env.OPENAI_MODEL ?? 'qwen3.8-max',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
}
// 工作目录的 setting.json 配置（交互式会话读取；id 与 model.name 匹配决定路由）
const settings = {
  model: {
    name: env.OPENAI_MODEL,
    generationConfig: { modalities: { image: true } }, // 开启多模态
  },
  env: {
    OPENAI_API_KEY: env.OPENAI_API_KEY,
  },
  modelProviders: {
    openai: [
      {
        id: 'qwen3.8-max',
        name: 'Qwen (百炼 token-plan)',
        envKey: 'OPENAI_API_KEY',
        baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        generationConfig: { modalities: { image: true } },
      },
    ],
  },
}
await mkdir(qwenDir, { recursive: true })
await writeFile(settingsPath, JSON.stringify(settings), 'utf-8')

// 调用 Qwen
const result = query({
  // skill 放在工作目录的 .qwen/skills 中
  prompt: 'use example skill, 做点什么',
  options: {
    cwd: workdir,
    permissionMode: 'yolo',
    includePartialMessages: true,
    env,
  },
})

const start_ts = Date.now()
// 流式输出 Qwen 结果
for await (const message of result) {
  // 系统信息
  if (message.type === 'system') {
    console.log(`${pc.cyan('[system]')}`, JSON.stringify(message))
  }

  // 工具调用信息
  else if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if (block.type === 'tool_use') {
        console.log(
          `${pc.cyan('[tool_use]')} [${block.id}] ${block.name} ${pc.dim(pc.gray(JSON.stringify(block.input)))}`,
        )
      }
    }
  }

  // 工具调用结果
  else if (message.type === 'user') {
    for (const block of message.message.content) {
      if (typeof block === 'string' || block.type !== 'tool_result') continue
      console.log(
        `${pc.cyan('[tool_result]')} [${block.tool_use_id}]`,
        block.is_error
          ? `${pc.red('error')} ${pc.dim(block.content)}`
          : `${pc.green('success')}`,
      )
    }
  }

  // 流式输出文本和思考内容
  else if (message.type === 'stream_event') {
    if (message.event.type === 'content_block_start') {
      if (['text', 'thinking'].includes(message.event.content_block.type))
        stdout.write(pc.cyan(`\n[${message.event.content_block.type}] `))
    }

    if (message.event.type === 'content_block_delta') {
      // 正文内容
      if (message.event.delta.type === 'text_delta')
        stdout.write(pc.bold(message.event.delta.text))
      // 思考内容
      if (message.event.delta.type === 'thinking_delta')
        stdout.write(pc.dim(message.event.delta.thinking))
    }
  }

  // 输出结果表示回答结束
  if (message.type === 'result') {
    console.log('\n\n--------------------\n')
    console.log(pc.cyan('[Token用量]'), message.usage)
  }
}
console.log(`${pc.cyan('[耗时]')} ${(Date.now() - start_ts) / 1000}s`)
