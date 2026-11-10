// agent-server/src/sdk/tokenCounter.js —— token 计数（usage 优先，缺失时 js-tiktoken 估算）
//
// 约定：优先用上游返回的 usage；缺失或非法时用 js-tiktoken 估算并标记 estimated:true。
// 估算为近似值，仅供指标/日志使用，不参与精确计费。

import { encodingForModel, getEncoding } from 'js-tiktoken'
import { config } from '../config/env.js'

/** 编码器缓存（按模型名；未知模型回退 cl100k_base） */
const encoderCache = new Map()

function encoderFor(modelName) {
  const name = modelName || config.model.name
  let enc = encoderCache.get(name)
  if (!enc) {
    try {
      enc = encodingForModel(name)
    } catch {
      enc = getEncoding('cl100k_base') // 未知模型回退通用编码器
    }
    encoderCache.set(name, enc)
  }
  return enc
}

/**
 * 统计 token：优先上游 usage，缺失时对 text 估算。
 * @param {object} [opts]
 * @param {{input_tokens?:number, prompt_tokens?:number, output_tokens?:number, completion_tokens?:number}} [opts.usage]
 *   OpenAI 兼容 usage 结构；input_tokens 或 prompt_tokens 任一非负整数即视为可信。
 * @param {string} [opts.text] usage 缺失时的估算源文本
 * @param {string} [opts.model] 模型名，缺省 config.model.name
 * @returns {{input:number, output:number, total:number, estimated:boolean}}
 *   estimated: true 表示 total 为 js-tiktoken 估算值（可 JSON 序列化）
 */
export function countTokens({ usage, text, model } = {}) {
  const input = usage?.input_tokens ?? usage?.prompt_tokens
  const output = usage?.output_tokens ?? usage?.completion_tokens
  const okInput = Number.isInteger(input) && input >= 0
  const okOutput = Number.isInteger(output) && output >= 0

  if (okInput) {
    return { input, output: okOutput ? output : 0, total: input + (okOutput ? output : 0), estimated: false }
  }

  const n = encoderFor(model).encode(String(text ?? '')).length
  return { input: n, output: 0, total: n, estimated: true }
}