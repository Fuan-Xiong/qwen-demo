// agent-server/src/sse.js —— SSE 写入器（事件载体，见核心约束事件集）
// 铁律（与 B1 src/harness/sse.js 对齐）：data 单行（序列化后不得含换行）、事件后空一行、
// 只由本模块发帧；心跳间隔来自 config.sse.keepaliveMs（默认 15s），close 清理定时器。

import { config } from './config/env.js'

/** 核心约束规定的 SSE 事件集 */
export const SSE_EVENTS = ['run_started', 'progress', 'message', 'result', 'metrics', 'warning', 'error', 'done']

/**
 * 为响应创建 SSE 处理器。
 * @param {import('node:http').ServerResponse} res
 * @param {{keepaliveMs?:number, events?:string[]}} [opts] keepaliveMs 默认 config.sse.keepaliveMs（测试可注入）
 * @returns {{send:(event:string, data:object|string)=>boolean, close:()=>void, closed:boolean}}
 */
export function createSSE(res, { keepaliveMs = config.sse.keepaliveMs, events = SSE_EVENTS } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  })
  res.flushHeaders?.() // 立即下发头，避免被代理缓冲

  let closed = false
  let timer = null

  const heartbeat = () => {
    if (!closed && !res.writableEnded) res.write(': ping\n\n')
  }
  const startTimer = () => {
    if (timer === null && keepaliveMs > 0) {
      timer = setInterval(heartbeat, keepaliveMs)
      timer.unref?.() // 不阻塞进程退出
    }
  }

  /** 关闭：幂等，清理心跳定时器并结束响应 */
  const close = () => {
    if (closed) return
    closed = true
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    if (!res.writableEnded) res.end()
  }

  /**
   * 发送一个事件帧。
   * @param {string} event 事件名（白名单校验）
   * @param {object|string} data 序列化为单行 JSON（字符串原样透传）
   * @returns {boolean} 已关闭时返回 false
   */
  const send = (event, data) => {
    if (closed || res.writableEnded) return false
    if (events.length && !events.includes(event)) throw new Error(`非法 SSE 事件名: ${event}`)
    const line = typeof data === 'string' ? data : JSON.stringify(data)
    if (line.includes('\n')) throw new Error(`SSE data 必须是单行（事件 ${event}），收到换行`)
    res.write(`event: ${event}\ndata: ${line}\n\n`)
    return true
  }

  // 连接关闭（客户端断开/响应结束）：自动清理，与主动 close 同语义
  res.on('close', () => close())

  startTimer()
  return { send, close, get closed() { return closed } }
}