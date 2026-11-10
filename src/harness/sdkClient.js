// src/sdkClient.js —— @qwen-code/sdk 封装（B1 Owner）
// 目标：模型、温度、max_tokens、并发数全部环境变量化；统一超时/重试/取消；调用失败可降级。
// 注意：SDK 的 query() 以"工作目录 + prompt"驱动，因此每个任务在 workspace/ 下用独立目录，
// 避免并发任务互相设置 .qwen/settings.json 打架。

import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { config, log } from '../config.js'

let sdkModule
async function loadSdk() {
  if (sdkModule !== undefined) return sdkModule
  try {
    sdkModule = await import('@qwen-code/sdk')
  } catch (err) {
    log.warn('未安装 @qwen-code/sdk，sdkClient 进入 offline 模式：', err.message)
    sdkModule = null
  }
  return sdkModule
}

/** 并发闸：Semaphore，防止一次评审把模型打满 */
class Semaphore {
  constructor(n) { this.n = Math.max(1, n); this.q = [] }
  async run(fn) {
    if (this.n <= 0) await new Promise((r) => this.q.push(r))
    this.n -= 1
    try { return await fn() } finally { this.n += 1; this.q.shift()?.() }
  }
}
const gate = new Semaphore(config.llm.concurrency)

/** 超时包装：超时 → 抛 TimeoutError，交给上层降级 */
function withTimeout(promise, ms, label) {
  let t
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => {
      const e = new Error(`${label} 超时 ${ms}ms`)
      e.name = 'TimeoutError'
      rej(e)
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t))
}

async function prepareWorkdir(taskId) {
  const dir = join(config.workspaceDir, `task-${taskId}`)
  await mkdir(join(dir, '.qwen'), { recursive: true })
  const settings = {
    model: { name: config.llm.model, generationConfig: { temperature: config.llm.temperature } },
    ...(config.llm.apiKey
      ? {
          // key 放顶层 env 块 + modelProviders 路由（id 与 model.name 一致才生效，qwen-demo 实测结论）
          env: { OPENAI_API_KEY: config.llm.apiKey },
          modelProviders: {
            openai: [
              {
                id: config.llm.model,
                name: 'Qwen (百炼 token-plan)',
                envKey: 'OPENAI_API_KEY',
                baseUrl: config.llm.baseURL,
              },
            ],
          },
        }
      : {
          // 覆盖用户目录下的全局 openai 配置，避免串到别的 key
          modelProviders: { openai: [] },
          // 无模型配置时只跑确定性规则，别让 SDK 卡在鉴权/网络等待（赛场上这是最常见的"假死"）
          offline: true,
        }),
  }
  await writeFile(join(dir, '.qwen', 'settings.json'), JSON.stringify(settings), 'utf-8')
  return dir
}

/**
 * 跑一次模型任务（带超时 / 重试 / 取消 / 并发闸）
 * @param {object} opts
 * @param {string} opts.prompt     完整提示词
 * @param {string} [opts.systemPrompt]
 * @param {string} [opts.skill]    要让 SDK 使用的 skill 名（放在工作目录 .qwen/skills/）
 * @param {AbortSignal} [opts.signal]
 * @param {(delta:string)=>void} [opts.onText] 流式增量回调（SSE message 事件用）
 * @param {(delta:string)=>void} [opts.onThinking]
 * @returns {Promise<{text:string, usage:{in:number,out:number}}>}
 */
export async function complete(opts) {
  const sdk = await loadSdk()
  if (!sdk?.query || !config.llm.apiKey) return offline(opts)

  const {
    prompt, systemPrompt, skill, signal,
    onText = () => {}, onThinking = () => {},
    retry = config.harness.retry, timeoutMs = config.harness.stepTimeoutMs,
  } = opts

  let lastErr
  for (let attempt = 0; attempt <= retry; attempt += 1) {
    if (signal?.aborted) throw abortError()
    const taskId = randomUUID().slice(0, 8)
    const cwd = await prepareWorkdir(taskId)
    try {
      const usage = { in: 0, out: 0 }
      const text = await gate.run(() => withTimeout((async () => {
        const result = sdk.query({
          prompt: systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt,
          options: {
            cwd,
            permissionMode: 'yolo',
            includePartialMessages: true,
            model: config.llm.model,
            env: {
              OPENAI_BASE_URL: config.llm.baseURL,
              OPENAI_API_KEY: config.llm.apiKey,
              OPENAI_MODEL: config.llm.model,
              OPENAI_MAX_TOKENS: String(config.llm.maxTokens),
              OPENAI_TEMPERATURE: String(config.llm.temperature),
            },
          },
        })

        let buf = ''
        for await (const msg of result) {
          if (signal?.aborted) throw abortError()
          if (msg.type === 'stream_event') {
            const ev = msg.event
            if (ev.type === 'content_block_delta') {
              if (ev.delta.type === 'text_delta') { buf += ev.delta.text; onText(ev.delta.text) }
              if (ev.delta.type === 'thinking_delta') onThinking(ev.delta.thinking ?? '')
            }
          } else if (msg.type === 'assistant') {
            for (const block of msg.message?.content ?? []) {
              if (block.type === 'text' && !buf.includes(block.text)) buf += block.text
            }
          } else if (msg.type === 'result') {
            usage.in = msg.usage?.input_tokens ?? msg.usage?.prompt_tokens ?? 0
            usage.out = msg.usage?.output_tokens ?? msg.usage?.completion_tokens ?? 0
            if (!buf && typeof msg.result === 'string') buf = msg.result
          }
        }
        return buf
      })(), timeoutMs, `llm:${taskId}`))

      return { text, usage }
    } catch (err) {
      lastErr = err
      if (signal?.aborted) throw abortError()
      // 换策略才有意义；同参数硬重试禁止（防死循环铁律之一）
      log.warn(`LLM 第 ${attempt + 1} 次失败：${err.name} ${err.message}`)
    } finally {
      rm(cwd, { recursive: true, force: true }).catch(() => {})
    }
  }
  const e = new Error(`LLM 调用失败（重试 ${retry} 次后）：${lastErr?.message}`)
  e.name = lastErr?.name === 'TimeoutError' ? 'TimeoutError' : 'LLMError'
  throw e
}

/** 无 SDK / 未配 key 时的降级：返回固定结构，保证链路可演示（B1 等 B2 时也用它） */
function offline({ prompt, onText = () => {} }) {
  const text = '[offline] 未连接模型，返回占位结果。配置 OPENAI_BASE_URL/OPENAI_API_KEY 后自动切换真实调用。'
  onText(text)
  return Promise.resolve({ text, usage: { in: Math.ceil(prompt.length / 4), out: 0 } })
}

export function abortError() {
  const e = new Error('aborted')
  e.name = 'AbortError'
  return e
}
