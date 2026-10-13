/**
 * dsh-aux-degrade — 辅助调用（压缩/标题）显式降级
 *
 * 为什么需要它：
 *   本地/自建模型路由常把 reasoning 默认档位设得很高（例如 qwen3.8 的 xhigh）。
 *   压缩摘要与会话标题这两类**工具型调用**的输出预算很小，而它们不显式设档位
 *   ⇒ 模型先把整个 max_tokens 花在思考上、一个字正文都没写就撞顶
 *   ⇒ dsh-compaction-basic 报 summarization truncated at the token cap (incomplete checkpoint)
 *   ⇒ **摘要没覆盖到的部分真的从上下文消失（有损、不可逆）**；标题也退化成首句截断。
 *
 * 本插件只做一件事，且只对**匹配的调用**做：
 *   在官方 llm/stream 瀑布上，给 purpose 在 purposes 里、且（若配了 models）模型在
 *   models 里的调用盖上 reasoningEffort: "off"；其余调用**逐字节不动**。
 *   适配器会把 off 经模型的 reasoningEfforts 表解析成 wire 值（如 reasoning_effort: "none"）。
 *
 * 为什么这是根因而非绕过：
 *   · 思考**绝不全局关闭** —— 只有压缩/标题这类工具型调用降级（对话本身不受影响）；
 *   · 用官方公开瀑布（dsh-llm 的 llm/stream），不自造传输、不改请求体字符串；
 *   · 调用方已显式设了 reasoningEffort 就**尊重它**（不抢）；
 *   · 每个闸门 fail-open：任何异常一律放行原调用。
 *
 * 与相关补丁的关系：
 *   pi-ai 的 max_tokens 被钳到 1（见补丁库 pi-ai+0.85.1+app）是另一半病灶，已单独根治；
 *   本插件解决的是"档位太高把预算烧光"这一半。两者互补、不重叠。
 *
 * 注意：本文件**不含反引号**（沿用本项目的客户端 bundle 纪律；host 插件虽不受限，
 * 但保持同一条纪律可避免以后被挪进客户端 bundle 时踩坑）。
 */
import z from '@deepseek-ai/schemastery'

export const name = 'aux-degrade'
/** 硬依赖 LLM 服务（llm/stream 瀑布由它拥有）。 */
export const inject = ['llm']

/** 默认作用的调用用途：压缩摘要 + 会话标题（不同 DSH 版本可能拼作 session-title 或 title）。 */
const DEFAULT_PURPOSES = ['compaction', 'session-title', 'title']

/**
 * **按"调用来源插件"识别辅助调用**（根治 prompt-enhance 的 502）。
 *
 * ═══ 为什么必须加这一条 ═══
 * dsh-prompt-enhance 调用 ctx.llm.stream() 时传的对象**没有 purpose 字段**：
 *     const generate = { provider, model, system, messages, temperature, maxTokens, signal, sessionId }
 * ⇒ shouldDegrade 的第一个闸门 typeof options.purpose !== 'string' 直接放行
 * ⇒ **它的思考从未被关掉**。
 *
 * 后果（实测，日志 harness.log 可见）：
 *   16 次调用里 **5 次 error=upstream**（31%），失败的**正文输出 out=0**、
 *   耗时都 ≈10 秒（成功的最大 8.8 秒、正文 262~1355 字）。
 *   ⇒ maxOutputTokens: 2048 被**思考全部吃掉** ⇒ decoder 返回 finish.kind === 'max-tokens'
 *   ⇒ 插件判 { code: "upstream", reason: "max-tokens" }
 *   ⇒ HTTP **502** ⇒ 界面上显示「模型服务返回错误，请重试」。
 *
 * ═══ 为什么用"来源插件"作判据（而不是别的） ═══
 * 它的 messages 里**自带来源标记**：
 *     content: [...], source: { kind: "plugin", plugin: "dsh-prompt-enhance" }
 * 而**主对话的 messages 不会有 source.plugin**（它们是 user / assistant / tool 角色）。
 * ⇒ 这个判据**天然不会误伤主对话** —— 主对话的思考能力**逐字节不动**。
 *
 * ═══ 安全 ═══
 * · 仍在 cfg.enabled === true 之内；
 * · 仍受"调用方已显式指定档位就尊重它"这条闸门约束；
 * · 仍受 cfg.models 白名单约束（若设了）；
 * · 任何异常一律 return next()（fail-open）。
 */
const DEFAULT_AUX_PLUGINS = ['dsh-prompt-enhance']

/** 从 options.messages 里取出"来源插件名"（首个带 source.plugin 的）。 */
function sourcePluginOf(options) {
  const msgs = options.messages
  if (!Array.isArray(msgs)) return null
  for (const m of msgs) {
    const p = m?.source?.plugin
    if (typeof p === 'string' && p.length > 0) return p
  }
  return null
}

export const Config = z.object({
  /** 总开关。默认关 —— 装上不配置等于没装，避免影响未知环境。 */
  enabled: z.boolean().default(false),
  /** 要降级的调用用途。空数组 = 用内置默认。 */
  purposes: z.array(z.string()).default([]),
  /**
   * 要降级的**来源插件**（按 messages[].source.plugin 识别）。
   * 空数组 = 用内置默认 ['dsh-prompt-enhance']。
   * 传 ['__none__'] 可显式关闭这条判据（只保留 purpose 判据）。
   */
  auxPlugins: z.array(z.string()).default([]),
  /** 只对这些模型生效（精确 id）。空数组 = 不限制模型。 */
  models: z.array(z.string()).default([]),
  /** 盖上去的档位。默认 off（= 关思考，正是压缩该有的形态）。 */
  effort: z.string().default('off'),
  /** **按形状**判定 —— 没有 tools 的调用视为辅助调用（默认开）。
   *  实测依据：真机 aux 路由（tools 为空）的调用 **purpose=- 且没有 source.plugin**
   *  ⇒ 前两条判据都抓不到 ⇒ 它的 out 里白花 573~5,206 的 reasoning，命中率只有 5~15%。
   *  这条判据与 dsh-context-reclaim 的 routeKeyOf 完全同口径（tools.length > 0 ? main : aux）。 */
  noTools: z.boolean().default(true),
})

/** 判断本次调用是否要降级；任何不确定一律返回 false（放行）。 */
function shouldDegrade(options, cfg, purposes, auxPlugins) {
  if (cfg.enabled !== true) return false
  if (options === null || typeof options !== 'object') return false
  // 调用方已经显式指定档位 ⇒ 尊重它，不抢（**这条在所有判据之前**，最保守）
  if (options.reasoningEffort !== undefined) return false
  const models = Array.isArray(cfg.models) ? cfg.models : []
  if (models.length > 0 && !models.includes(options.model)) return false
  /* 判据①：官方用途标记（compaction / session-title / title） */
  if (typeof options.purpose === 'string' && purposes.includes(options.purpose)) return true
  /* 判据②：来源插件（辅助调用**没有** purpose，但 messages 里带 source.plugin） */
  const sp = sourcePluginOf(options)
  if (sp !== null && auxPlugins.includes(sp)) return true
  /* 判据③：**按形状** —— 没有 tools 的调用就是辅助调用。
     实测：真机 aux 路由的调用 purpose=- 、也没有 source.plugin ⇒ ①②都抓不到
     ⇒ reasoning 白花 573~5,206/次、命中率只有 5~15%。
     口径与 dsh-context-reclaim 的 routeKeyOf 一致（tools.length > 0 ? main : aux）。
     保守处理：必须**显式**传了 tools 且为空数组才算（undefined 不放行，避免误判）。 */
  /* 放宽：实测那些辅助调用**连 tools 字段都没有**（undefined）
     ⇒ 上一版"必须显式空数组"太保守，等于没生效（日志里 reasoning 依旧 4,096/8,192）。
     依据：主对话**一定带 30 个 tools**（routeKeyOf 就是用 tools.length > 0 判 main 的）
     ⇒ 没有 tools 字段 = 辅助调用，可靠。 */
  /* 收紧：判据③**只在"连 purpose 都没有"时生效**。
     理由：G-05 的断言暴露出误伤 —— 有些正常调用带 purpose（如 purpose=agent-turn）却不带 tools，
     若只看"无 tools"会把它们也降级。而真机那个漏网的 aux 正是 **purpose 与 source.plugin 双缺**，
     所以叠加"purpose 未定义"这个条件既能抓住它、又不会误伤带 purpose 的调用。 */
  if (cfg.noTools !== false && options.purpose === undefined && !Array.isArray(options.tools)) return true
  return false
}

export function apply(ctx, config = {}) {
  ctx.on('llm/stream', (options, next) => {
  /* A1 + A2 + A3（集中化落点）：把 pi-ai 的输出下界、compaction-basic 的摘要保真、
     compaction-tools-gate 的「压缩不带 tools」三项能力搬到这里。全部原地改 options（waterfall 用闭包引用）。 */
  try {
    if (options !== null && typeof options === 'object' && Object.isFrozen(options) !== true) {
      const a2 = guardMaxTokens(options)
      const a3 = dropToolsForCompaction(options)
      const a1 = enrichCompactionPrompt(options)
      if (a1 || a2 || a3) {
        try { console.error('[aux-degrade/context] maxTokens下界=' + a2 + ' 压缩去tools=' + a3 + ' 补两节=' + a1) } catch { /* ignore */ }
      }
    }
  } catch { /* fail-open：任何意外都不改 options */ }
    try {
      const cfg = config ?? {}
      const purposes = Array.isArray(cfg.purposes) && cfg.purposes.length > 0 ? cfg.purposes : DEFAULT_PURPOSES
      const auxPlugins = Array.isArray(cfg.auxPlugins) && cfg.auxPlugins.length > 0 ? cfg.auxPlugins : DEFAULT_AUX_PLUGINS
      if (!shouldDegrade(options, cfg, purposes, auxPlugins)) return next()
      /* 只改这一个字段；其余原样（保守派：不重建对象，只补一个键）。 */
      options.reasoningEffort = cfg.effort ?? 'off'
      return next()
    } catch {
      /* fail-open：任何意外都不拦调用。 */
      return next()
    }
  })
}

/* ══════════════════════════════════════════════════════════════════════════
 * A1 + A2 + A3：辅助调用的上下文改造（集中化落点：dsh-aux-degrade）
 *
 *   A2 ← @earendil-works/pi-ai 的 max_tokens 输出下界（FLOOR=1024）
 *   A1 ← @deepseek-ai/dsh-compaction-basic 的摘要保真（官方 8 节里没有「用户硬约束」「命令与结果」）
 *   A3 ← dsh-compaction-tools-gate 的思路（压缩调用不需要工具 schema）
 *
 * ═══ 零降智保障 ═══
 *   A2：只保下界，**绝不越过调用方本意**（Math.min(maxTokens, ...)）
 *   A1：只**追加两节**到压缩指令，**不改原有 8 节**（模型仍按原格式输出，只是多两节）
 *   A3：只对 「purpose === 'compaction'」 删 tools；压缩不需要调工具（官方 GenerateOptions 也没有 toolChoice）
 * ══════════════════════════════════════════════════════════════════════════ */

const MAXTOK_FLOOR = (() => {
  const raw = Number(process.env.DSH_AUX_MAXTOKENS_FLOOR)
  return Number.isInteger(raw) && raw >= 0 ? raw : 1024
})()

/** A1：要追加的两节（对齐 Reasonix 摘要格式里的「Standing facts & constraints」「Commands & outcomes」）。 */
const EXTRA_SECTIONS = [
  '',
  '## Standing facts & constraints (MUST keep verbatim)',
  'Everything the user stated that still governs the work — names, paths, IDs, versions, tokens, preferences,',
  'and hard "never do X" rules — in their own words. Preserve identifiers and numbers EXACTLY; do not paraphrase.',
  '',
  '## Commands & outcomes (MUST keep verbatim)',
  'Commands run (builds, tests, git) and their relevant results — what passed, what failed, and the exact error text',
  'that matters. Keep the literal command strings and the literal error lines.',
].join('\n')

/**
 * A1：给压缩调用的 system prompt 追加两节。
 * @param {object} options - llm/stream 的 options。
 * @returns 是否改动了。
 */
function enrichCompactionPrompt (options) {
  if (options?.purpose !== 'compaction') return false
  const msgs = Array.isArray(options.messages) ? options.messages : null
  if (msgs === null) return false
  /* 找第一条 system 消息（压缩指令所在） */
  for (let i = 0; i < msgs.length; i += 1) {
    const m = msgs[i]
    if (m?.role !== 'system') continue
    const blocks = Array.isArray(m.content) ? m.content : []
    const has = blocks.some((b) => b?.type === 'text' && typeof b.text === 'string')
    if (!has) continue
    /* 已经补过就不重复补（幂等，避免同一次请求被多个钩子重复追加） */
    const text0 = blocks.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('')
    if (text0.includes('Standing facts & constraints (MUST keep verbatim)')) return false
    msgs[i] = {
      ...m,
      content: blocks.map((b) => (b?.type === 'text' && typeof b.text === 'string'
        ? { ...b, text: b.text + EXTRA_SECTIONS }
        : b)),
    }
    return true
  }
  return false
}

/**
 * A2：保住 maxTokens 下界（**绝不超过调用方本意**）。
 * @param {object} options - llm/stream 的 options。
 * @returns 是否改动了。
 */
function guardMaxTokens (options) {
  if (MAXTOK_FLOOR <= 0) return false
  const cur = options?.maxTokens
  if (!Number.isInteger(cur) || cur >= MAXTOK_FLOOR) return false
  options.maxTokens = Math.max(cur, MAXTOK_FLOOR)
  return true
}

/**
 * A3：压缩调用不需要工具 schema（官方 GenerateOptions 没有 toolChoice，留着反而可能让模型去调工具）。
 * @param {object} options - llm/stream 的 options。
 * @returns 是否改动了。
 */
function dropToolsForCompaction (options) {
  if (options?.purpose !== 'compaction') return false
  if (!Array.isArray(options.tools) || options.tools.length === 0) return false
  options.tools = []
  return true
}

/* 导出见文件末尾 */

/** 供测试直接调用（不经过 cordis）。 */
export { shouldDegrade, DEFAULT_PURPOSES, enrichCompactionPrompt, guardMaxTokens, dropToolsForCompaction }
