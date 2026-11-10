// agent-server/src/metrics/metrics.js —— 运行时指标聚合器
// 记录：tokens(prompt/completion/total/estimated) / stages / rules / llmCalls / skills / elapsedMs；
// snapshot() 返回可 JSON 序列化纯对象（无 Map/函数/undefined），供 done 事件与复跑日志使用。

/**
 * 创建指标聚合器（实例自有状态，互不共享）。
 * @returns {{
 *   addTokens:({prompt?:number,completion?:number,estimated?:boolean})=>object,
 *   addLlmCall:(usage?:object)=>object,
 *   addStage:(name:string, durationMs:number)=>object,
 *   addRuleResult:(status:string)=>object,
 *   addSkill:(name:string)=>object,
 *   elapsedMs:()=>number,
 *   snapshot:()=>object,
 * }}
 */
export function createMetrics() {
  const state = {
    tokens: { prompt: 0, completion: 0, total: 0, estimated: false },
    stages: {}, // stageName -> durationMs（同阶段可累加）
    rules: { total: 0, pass: 0, fail: 0, review: 0, failed: 0 },
    llmCalls: 0,
    skills: {}, // skillName -> { calls: n }
    startedAt: Date.now(),
  }

  return {
    /** 累加 token 用量；estimated 任一为 true 即整体标记估算（与 tokenCounter 语义一致） */
    addTokens({ prompt = 0, completion = 0, estimated = false } = {}) {
      state.tokens.prompt += prompt
      state.tokens.completion += completion
      state.tokens.total += prompt + completion
      if (estimated) state.tokens.estimated = true
      return this
    },

    /** 记录一次 LLM 调用；可带 usage（OpenAI 兼容/归一化后的 {prompt/completion}）联动累加 tokens */
    addLlmCall(usage) {
      state.llmCalls += 1
      if (usage) this.addTokens({
        prompt: usage.prompt ?? usage.prompt_tokens ?? usage.input_tokens ?? 0,
        completion: usage.completion ?? usage.completion_tokens ?? usage.output_tokens ?? 0,
        estimated: usage.estimated,
      })
      return this
    },

    /** 记录一个阶段的耗时（同阶段多次调用累加） */
    addStage(name, durationMs) {
      const n = Number(durationMs)
      if (Number.isFinite(n) && n >= 0) {
        state.stages[name] = (state.stages[name] ?? 0) + n
      }
      return this
    },

    /** 累计规则结果计数（pass/fail/review/failed；未知状态计入 failed 防丢） */
    addRuleResult(status) {
      state.rules.total += 1
      const key = ['pass', 'fail', 'review', 'failed'].includes(status) ? status : 'failed'
      state.rules[key] += 1
      return this
    },

    /** 累计某技能的调用次数 */
    addSkill(name) {
      if (!state.skills[name]) state.skills[name] = { calls: 0 }
      state.skills[name].calls += 1
      return this
    },

    /** 从聚合器创建起的实时耗时（ms） */
    elapsedMs() {
      return Date.now() - state.startedAt
    },

    /** 可 JSON 序列化快照（浅拷贝，值均为原始类型） */
    snapshot() {
      return {
        tokens: { ...state.tokens },
        stages: { ...state.stages },
        rules: { ...state.rules },
        llmCalls: state.llmCalls,
        skills: JSON.parse(JSON.stringify(state.skills)),
        elapsedMs: this.elapsedMs(),
      }
    },
  }
}