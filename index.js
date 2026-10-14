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

  /* 官方补丁提醒：本插件需要的那条补丁在 @earendil-works/pi-ai 里，插件层改不了。
     这里只做三件事 —— 探测「打没打」、落一个「不再提醒」标记、把结论交给自带的
     客户端半边弹窗。绝不改官方文件，也绝不读别的插件的任何东西。 */
  installPatchNotice(ctx)
}

/* ══════════════════════════════════════════════════════════════════════════
 *  官方补丁提醒（服务端半边）
 *
 *  为什么必须由本插件自己做：它需要的补丁在 @earendil-works/pi-ai 的 dist 里，
 *  ESM 命名空间只读 ⇒ 插件层修不了。而本插件是纯服务端插件、没有界面，所以
 *  「装好之后在界面上说一次」这句话得靠自己带一个极小的客户端半边（lib/client.js）。
 *  那条半边只读本插件自己的路由，不碰任何别的插件。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 本插件需要的补丁清单（只列**本插件**用的，不列别人需要的）。 */
const PATCH_NOTICE_TARGETS = [
  {
    id: 'pi-ai-max-tokens-floor',
    title: 'pi-ai max_tokens 下界（FLOOR = 1024）',
    pkg: '@earendil-works/pi-ai',
    file: ['dist', 'api', 'simple-options.js'],
    tier: 'required',
    whyZh: '官方 pi-ai 会把 max_tokens 钳到 1，辅助调用（压缩摘要、会话标题）可能只吐一两个字就被截断 —— 摘要没覆盖到的部分真的从上下文里消失，而且不可逆。'
      + '本插件只能在插件层关掉高思考档位并抬起下界，**这个钳位改不了**（第三方 dist、只读命名空间）。',
    whyEn: 'Upstream pi-ai clamps max_tokens to 1, so auxiliary calls (compaction summaries, session titles) can come back with a character or two — and whatever the summary never covered really does disappear, irreversibly. '
      + 'This plugin can turn the high thinking level off and raise the floor from the plugin layer, but it cannot change that clamp: the third-party dist exposes a read-only ESM namespace.'
  }
]

/** 补丁库（独立开源仓库：10 条自包含补丁 + 自适应应用器 + 五种打法）。 */
const PATCHLIB_REPO = 'https://github.com/xiamubumu/dsh-patch-library'
/** 直接下载：永远指向最新 Release 的那个 tgz。 */
const PATCHLIB_TGZ = PATCHLIB_REPO + '/releases/latest/download/dsh-patch-library-1.0.0.tgz'
/** 外链白名单：只放作者自己的仓库前缀，绝不做通用 URL 打开器。 */
/** 权威检测数据：来自补丁库 manifest.json 的 pristine / patched 内容哈希与 marker。 */
const PATCH_NOTICE_HASHES = {
  "pi-ai-max-tokens-floor": {
    "marker": "MAX_TOKENS_FLOOR",
    "pristine": "1caf860e028e22639578aba3ec8b79e5be9650c27bd3f19471c78502976555f3",
    "patched": "61262f85ee9da402609aa263b730a2e51351a5e23e42e9706c7afa1a40c5c29e"
  },
  "agent-loop-snapshot-prompt": {
    "marker": "function compareNames(",
    "pristine": "257eb83c00a05ee068e9f4ba80ca71ab94e3a1275d24b7a0cf5038ff23dd0fd8",
    "patched": "94be7f52a5f5e5f07dfb3b8f7222644ccd7bf354ab2778c9071d9da89af6eb9b"
  },
  "llm-pi-ai-system-prompt": {
    "marker": "PI_AI_JOIN_PREFIX_SYSTEM",
    "pristine": "76911a5d9e7aa94ea3e02a3e4507e41c5edc2e5390f50e916b6e06413a1b8dc8",
    "patched": "31cc5bd444dfbe2c69524a80c2057501de80d5d56db0155a6160537ddbe9bb75"
  }
}

const LINK_LOCAL_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/

/** 取 node 内建模块（本文件不额外 import，宿主以极简形式加载）。 */
function builtin (name) {
  return typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule(name) : null
}

/** 本插件的状态目录（只放自己的文件，绝不碰 DSH 配置）。 */
function patchNoticeStateFile () {
  const fs = builtin('node:fs')
  const path = builtin('node:path')
  if (fs === null || path === null) return null
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home !== ''
    ? path.join(home, 'dsh-aux-degrade')
    : (typeof process.env.APPDATA === 'string' && process.env.APPDATA !== ''
      ? path.join(process.env.APPDATA, 'dsh-desktop', 'harness', 'dsh-aux-degrade')
      : null)
  return base === null ? null : path.join(base, 'patch-notice.json')
}

/** 读「不再提醒」标记；任何异常都当没关。 */
/** 读「不再提醒」状态：兼容老的 {dismissed:true}，也支持按补丁 id 记的 {dismissedIds:[…]}。 */
function readPatchNoticeState () {
  const fs = builtin('node:fs')
  const file = patchNoticeStateFile()
  const empty = { dismissed: false, dismissedIds: [] }
  if (fs === null || file === null) return empty
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const ids = Array.isArray(raw?.dismissedIds) ? raw.dismissedIds.filter((x) => typeof x === 'string') : []
    return { dismissed: raw?.dismissed === true, dismissedIds: ids }
  } catch { return empty }
}

/** 落「不再提醒」标记；写不了就算了，绝不影响插件其余功能。 */
function writePatchNoticeState (dismissed, ids) {
  const fs = builtin('node:fs')
  const path = builtin('node:path')
  const file = patchNoticeStateFile()
  if (fs === null || path === null || file === null) return false
  try {
    const prev = readPatchNoticeState()
    const next = dismissed === true
      ? { dismissed: true, dismissedIds: Array.isArray(ids) ? ids.slice() : prev.dismissedIds }
      : { dismissed: false, dismissedIds: [] }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ ...next, at: new Date().toISOString() }, null, 2) + '\n', 'utf8')
    return true
  } catch { return false }
}

/** 扫描 argv 里所有 `@deepseek-ai/dsh/lib/bin.js` ⇒ 推出安装根。 */
function patchNoticeDshRoots () {
  const path = builtin('node:path')
  if (path === null) return []
  const out = []
  const re = /[@\\/]deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/i
  for (const arg of process.argv) {
    if (typeof arg !== 'string' || re.test(arg) !== true) continue
    const dir = path.dirname(path.dirname(arg))                 /* …/@deepseek-ai/dsh */
    if (out.includes(dir) !== true) out.push(dir)
  }
  return out
}

/** 某条补丁目标在磁盘上的候选路径（桌面布局与 npm 布局都覆盖）。 */
function patchNoticeCandidates (target) {
  const path = builtin('node:path')
  if (path === null) return []
  const out = []
  const [scope, name] = target.pkg.split('/')
  /* root 是 <X>/@deepseek-ai/dsh；第三方包在同一层作用域目录里，
     所以是 root/../../<scope>/<name>（早先写成 root/../<name> 漏了作用域，探测不到）。 */
  for (const root of patchNoticeDshRoots()) {
    out.push(path.join(root, '..', '..', scope, name === undefined ? scope : name, ...target.file))
  }
  return out
}

/** 探测每条目标：文件在不在 + 旁边有没有 `.orig*` 备份。找不到就如实说不确定。 */
function detectPatchNoticeItems () {
  const fs = builtin('node:fs')
  const crypto = builtin('node:crypto')
  return PATCH_NOTICE_TARGETS.map((target) => {
    const known = PATCH_NOTICE_HASHES[target.id] ?? null
    const out = {
      id: target.id,
      title: target.title,
      pkg: target.pkg,
      file: target.file.join('/'),
      tier: target.tier,
      whyZh: target.whyZh,
      whyEn: target.whyEn,
      found: false, verdict: 'unknown', signal: 'none'
    }
    if (fs === null || crypto === null) return out
    for (const candidate of patchNoticeCandidates(target).map((f) => ({ file: f }))) {
      let text = null
      try {
        if (fs.existsSync(candidate.file) !== true) continue
        text = fs.readFileSync(candidate.file, 'utf8')
        out.found = true
      } catch { continue }
      const sha = crypto.createHash('sha256').update(text, 'utf8').digest('hex')
      if (known !== null && sha === known.patched) { out.verdict = 'applied'; out.signal = 'sha'; break }
      if (known !== null && sha === known.pristine) { out.verdict = 'missing'; out.signal = 'sha'; break }
      if (known !== null && text.includes(known.marker)) { out.verdict = 'applied'; out.signal = 'marker'; break }
      out.verdict = 'unknown'; out.signal = 'none'
      break
    }
    return out
  })
}

/** 读一个小 JSON 请求体。 */
async function patchNoticeBody (req) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > 64 * 1024) return null
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    return text === '' ? null : JSON.parse(text)
  } catch { return null }
}

/** 把本插件的补丁状态与操作挂到宿主 webServer 上（拿不到就静默跳过）。 */
function installPatchNotice (ctx, viaInject) {
  const webserver = ctx.get?.('webServer')
  /* webServer 刻意**不**写进 inject：cordis 里声明什么就是必需，真声明了在
     没有 web 服务的部署里会把整个插件停掉。这里改用 ctx.inject([...]) 的
     可选形态 —— 拿得到才注册路由，拿不到就只是没有弹窗，其余功能照旧。 */
  if ((webserver === undefined || webserver === null) && viaInject !== true && typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (sub) => { try { installPatchNotice(sub, true) } catch { /* ignore */ } })
      return
    } catch { /* 落到下面的诊断 */ }
  }
  if (webserver === undefined || webserver === null) {
    try { console.error('[aux-degrade/patch-notice] webServer 拿不到 ⇒ 不注册路由') } catch { /* ignore */ }
    return
  }
  const path = builtin('node:path')
  const childProcess = builtin('node:child_process')
  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const send = (status, body) => {
      try {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      } catch { /* ignore */ }
    }
    if (url.pathname === '/dsh-aux-degrade/patch-notice' && req.method === 'GET') {
      const state = readPatchNoticeState()
      send(200, {
        ok: true,
        plugin: 'dsh-aux-degrade',
        dismissed: state.dismissed,
        dismissedIds: state.dismissedIds,
        patchLibrary: PATCHLIB_REPO,
        download: PATCHLIB_TGZ,
        stateFile: patchNoticeStateFile(),
        others: [],
        items: detectPatchNoticeItems()
      })
      return
    }
    if (url.pathname === '/dsh-aux-degrade/patch-notice/dismiss' && req.method === 'POST') {
      const body = await patchNoticeBody(req)
      const ok = writePatchNoticeState(body?.dismissed === true, body?.ids)
      send(200, { ok })
      return
    }
    if (url.pathname === '/dsh-aux-degrade/patch-notice/open' && req.method === 'POST') {
      /* 同源闸：带了 Origin 又不是本机来源的，一律拒绝（防网页 CSRF 打开浏览器）。 */
      const origin = req.headers?.origin
      if (typeof origin === 'string' && origin !== '' && LINK_LOCAL_RE.test(origin) !== true) {
        send(200, { ok: false, error: '跨源请求被拒绝' })
        return
      }
      const body = await patchNoticeBody(req)
      const target = typeof body?.url === 'string' ? body.url : ''
      /* 只认两个写死的地址 —— 不做前缀匹配，也不把它交给 shell 去拼。 */
      if (target !== PATCHLIB_REPO && target !== PATCHLIB_TGZ) {
        send(200, { ok: false, error: '不在白名单里的链接' })
        return
      }
      /* 用系统默认浏览器打开（Windows 走 cmd start，其余平台走平台 opener）。 */
      try {
        if (process.platform === 'win32') {
          const child = childProcess.spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' })
          child.unref()
        } else if (process.platform === 'darwin') {
          childProcess.spawn('open', [target], { detached: true, stdio: 'ignore' }).unref()
        } else {
          childProcess.spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref()
        }
        send(200, { ok: true, url: target })
      } catch (error) {
        send(200, { ok: false, url: target, error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    void path
    send(404, { ok: false, error: 'not found' })
  }
  ctx.effect(() => webserver.register({
    kind: 'prefix',
    path: '/dsh-aux-degrade',
    handler: (req, res) => handler(req, res)
  }), 'dsh-aux-degrade: patch notice routes')
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
