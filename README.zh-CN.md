<div align="center">

# dsh-aux-degrade

**压缩摘要和会话标题不再被高思考档烧光输出预算。**

> ⚠️ **只支持 DSH 1.5**（`>=0.1.5-rc.2 <0.2.0`）。DSH 出新版本会跟进更新。


[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-1.5-8a2be2.svg)](#兼容性)
[![Platform](https://img.shields.io/badge/platform-desktop%20%7C%20web-lightgrey.svg)](#兼容性)

[English](README.md) · **简体中文**

</div>

---

## 这是什么

DSH 会话里除了主对话，还有一堆**辅助 LLM 调用**在背后跑：生成压缩摘要、起会话标题、给提示词增强。

它们和主对话共用同一个模型，却往往**没有指定思考强度**——于是继承你设的高档位，把整个输出预算烧在推理上。结果是压缩摘要写到一半被 `max_tokens` 截断，而截断是**静默**的：你不报错，只是下一轮开始上下文缺了一块。会话标题顶到一半变成半个词，也是同一个病。

`dsh-aux-degrade` 挂在 `llm/stream` 瀑布上，在辅助调用发出去之前把它改小。

---

## 它做的四件事

四件事都发生在同一个 `llm/stream` 钩子里。**注意：只有第 1 件受 `enabled` 开关控制**，第 2–4 件在任何配置下都会执行——这是有意的，它们修的是「上游插件省略了必填信息」这类问题，不是可选的优化。

### 1. 把思考强度降到 `off`

满足下列条件之一，就把这次调用的 `reasoningEffort` 盖成 `off`：

| 判据 | 说明 |
|---|---|
| **按用途** | `purpose` 落在 `purposes` 列表里（默认覆盖 `compaction`、`session-title`、`title`） |
| **按来源插件** | 发起方在 `auxPlugins` 列表里（默认识别 `dsh-prompt-enhance`） |
| **按形状** | `purpose` 未声明、且 `tools` 不是数组——这种调用形状上就是辅助调用 |

**且**调用方自己没有显式指定过 `reasoningEffort`。如果它自己设了档位，本插件放行，不覆盖别人的明确意图。

想换成别的档位而不是 `off`：`config.effort = 'low'` 之类。

### 2. 把 `maxTokens` 抬到不低于 1024

有些调用方把 `maxTokens` 设得极小（最坏情况是 1），配上一个高思考档位，等于「还没开始写正文就被截断」。

本插件给它一个下界：**不低于 1024**。可用环境变量覆盖：

```bash
DSH_AUX_MAXTOKENS_FLOOR=2048    # 换个下界
DSH_AUX_MAXTOKENS_FLOOR=0       # 关掉这一项
```

### 3. 给压缩指令追加两节保真要求

压缩摘要最大的风险不是「短」，是「丢」。摘要生成器在压力下会优先保留叙述、丢掉硬事实：路径、命令、错误码、约束。

只要这次调用的 `purpose === 'compaction'`，插件就往压缩指令末尾追加两节：

```markdown
## Standing facts & constraints (MUST keep verbatim)

## Commands & outcomes (MUST keep verbatim)
```

**幂等**：指令里已经有这两节就不会重复追加。

### 4. 压缩调用清空 `tools`

压缩摘要不需要调用任何工具。留着工具定义既占 prompt、又给了模型「顺手去调一次工具」的机会——那会让一次本该纯文本的摘要生成变成多轮往返。

对 `purpose === 'compaction'` 的调用，`tools` 被清空。可用 `config.noTools = false` 关掉。

### 日志

只要第 2–4 件里任何一件动了手，就打一行：

```
[aux-degrade/context] maxTokens下界=1024 压缩去tools=true 补两节=true
```

---

## 9. 官方补丁提醒：装好就弹一次，指到哪条、怎么打

本插件**必须**打的那条官方补丁（`pi-ai-max-tokens-floor`，改 `@earendil-works/pi-ai` 的 `dist/api/simple-options.js`），由**本插件自己**在界面上弹一次窗告诉你。

为什么它必须打：pi-ai 在上游会把 `max_tokens` 钳到 1，辅助调用（压缩摘要、会话标题）可能只吐一两个字就被截断 —— 摘要没覆盖到的部分真的从上下文里消失。本插件只能在插件层关掉高思考档位并抬起下界，**那个钳位它改不了**（第三方 dist、ESM 命名空间只读）。

- **怎么打（三种，任选一种）**：**A** 点弹窗里的「复制提示词」交给**你自己的 agent**；**B** `node apply.mjs --check` 体检、`node apply.mjs --apply --only pi-ai-max-tokens-floor` 打；**C** 手动 `git apply -p1`；
- **补丁库**：<https://github.com/xiamubumu/dsh-patch-library>；
- **检测系统**：按**内容哈希**（`pristine` / `patched`）与 `*.orig` 备份判断；不确定就**明说「无法判定」**，绝不猜「已打」；
- **打完就不再弹**；「不再提醒」是永久的，而且**按补丁 id 记** —— 将来新增的补丁仍然会提醒。

弹窗还会列出**其余官方补丁**（不绑定本插件，按症状决定打不打），保证一条都不漏。

## 配置

配置文件是 profile 的 `cordis.patch.yml`：

```yaml
- id: aux-degrade
  config:
    enabled: true
    purposes: []
    models: []
    effort: off
```

| 键 | 类型 | 代码默认 | 作用 |
|---|---|---|---|
| `enabled` | boolean | **`false`** | 只控制第 1 件（降思考强度）。配了 `true` 才生效——本仓库的 `cordis.patch.yml` 里配的就是 `true` |
| `purposes` | string[] | `[]` → `['compaction', 'session-title', 'title']` | 按用途识别辅助调用 |
| `auxPlugins` | string[] | `[]` → `['dsh-prompt-enhance']` | 按来源插件识别辅助调用。传 `['__none__']` 可整体关掉这条判据 |
| `models` | string[] | `[]`（不限） | 只对指定模型生效 |
| `effort` | string | `'off'` | 降到的档位 |
| `noTools` | boolean | `true` | 压缩调用是否清空 `tools`（第 4 件） |

> ⚠️ **`enabled: false` 不等于「零副作用」。** 旧文档里是这么写的，不对。`enabled` 只拦得住第 1 件（降思考强度）；第 2–4 件（抬 `maxTokens` 下界、补两节保真要求、压缩清 `tools`）在代码里跑在任何 `enabled` 检查**之前**，只要满足了 `purpose` 条件就会执行。想让第 2 件停下来，用 `DSH_AUX_MAXTOKENS_FLOOR=0`；第 4 件用 `config.noTools = false`；第 3 件（补两节）没有单独的开关。

### 为什么默认识别 `dsh-prompt-enhance`？

因为它发起调用时**不传 `purpose`**——上面三条判据里「按用途」这一条对它完全失效。没了这条 `auxPlugins` 判据，它的调用会一路继承高档位思考强度，输出预算被推理吃光，表现为大量 502 与半个响应。这条判据就是为它加的。

---

## 📚 教程

| 文档 | 讲什么 |
|---|---|
| [安装与官方补丁（中文）](tutorial-install-and-official-patches.zh-CN.md) | 四个插件怎么一起装（两条实测路线），官方补丁要不要打、怎么让**你自己的 agent** 去打 补丁本体已开源成补丁库：<https://github.com/xiamubumu/dsh-patch-library>  |
| [Install & official patches (English)](tutorial-install-and-official-patches.md) | the same, in English the patches themselves ship as a library: <https://github.com/xiamubumu/dsh-patch-library>  |

---

## 🔗 同系列

四个插件各自独立、可单装，但配在一起最省。另外三个：

- [`dsh-context-reclaim`](https://github.com/xiamubumu/dsh-context-reclaim) — 上下文回收：工具结果有界化、工具面折叠、前缀稳定化，长会话不越聊越贵
- [`dsh-capability-composer`](https://github.com/xiamubumu/dsh-capability-composer) — 能力组合：把常驻工具面收成几个组合，按需切换
- [`dsh-composer-launcher`](https://github.com/xiamubumu/dsh-composer-launcher) — 「+」启动器：一个面板统管组合 / 插件 / MCP，并引导装扩展

> 全部**只支持 DSH 1.5**，DSH 出新版本会跟进更新。需要打官方补丁的插件装好后会自己弹窗说清楚，一条不漏。

## 安装

### 从 GitHub（推荐，已在全新 `DSH_HOME` 上实测）

```bash
dsh plugin --profile web add github:xiamubumu/dsh-aux-degrade
```

一条命令装好；DSH 会自己把它登记进 profile 的 `dsh.profile.bundles`。

### 从本地 tarball（离线机器）

去 [Releases](https://github.com/xiamubumu/dsh-aux-degrade/releases) 下载 `dsh-aux-degrade-1.1.0.tgz`，然后：

```bash
dsh plugin --profile web add /path/to/dsh-aux-degrade-1.1.0.tgz
```

### 从 DSH 插件市场 / npm（暂时还不行）

市场投稿（`awesome-dsh-plugin` 的 PR）还没提交，npm 上也还没发布 ⇒ **现在这两种方式都装不到**。
收录 / 发布之后，市场里直接点安装、或者 `dsh plugin --profile web add dsh-aux-degrade` 才成立。

> ⚠️ **已知问题：不要拿 Release 资产的 tarball URL 直接装。**
> `dsh plugin --profile web add https://github.com/.../releases/download/v1.1.0/....tgz` 在 DSH 自带的 pnpm 10.34.5 上会失败：
> `ERR_PNPM_MISSING_TARBALL_INTEGRITY`（[pnpm#14351](https://github.com/pnpm/pnpm/issues/14351)，上游在 pnpm ≥ 12.5.1 才修好）。
> 连装第二个插件时**必然**失败 —— 请用上面两条路（`github:` 简写，或先下载 tarball 再用本地路径）。

装完**需要重启 DSH**——宿主侧插件只在 DSH 启动时装载。

本插件**没有任何运行时依赖**，`peerDependencies` 只声明官方的 `@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-llm`。

---

## 兼容性

| | |
|---|---|
| **DSH 内核** | **1.5 系列**（`0.1.5-rc.2` ≤ 版本 < `0.2.0`）—— `package.json` 的 `engines.dsh` 就是写的这个范围。后续 DSH 版本会跟进 |
| **形态** | **桌面版 ✅ · 网页版 ✅** —— 准确地说，**只要跑的是 DSH 就支持**，本插件只挂 Cordis 的 `llm/stream` 接缝，不依赖任何桌面专属能力 |
| **操作系统** | Windows · macOS · Linux |
| **Node 语法** | 20 及以上（**不需要你自己装 Node**，DSH 自带运行时） |

---

## 🔗 与其它插件的联动

### 🔗 与 `dsh-context-reclaim`（上下文治理两件套）—— 请务必一起安装

`dsh-aux-degrade` 与 [`dsh-context-reclaim`](https://github.com/xiamubumu/dsh-context-reclaim) 是同一套「上下文治理」方案的两半。**强烈建议同时安装，这是本插件最重要的联动关系。**

**① 它们共享同一个路由口径。** 两个插件用同一个判据区分「主对话调用」与「辅助调用」：

```
tools.length > 0 ? 'main' : 'aux'
```

reclaim 用它给每请求打 `route=` 标签，aux-degrade 用它决定这次调用算不算辅助调用。口径一致，两个插件才不会一边省着、一边漏着。

> 有一个细节值得知道：两边的判据**不是逐字相同**。reclaim 看的是 `tools` 数组有没有内容；aux-degrade 在「按形状」那条判据上还额外要求 `purpose === undefined`，为的是不误伤那些显式声明了用途的主对话调用。所以「被降级的调用」是「aux 路由」的一个子集——**降级比路由更保守**，这是有意的。

**② 它们的分工。** aux-degrade 管**调用**（这次调用花多少思考预算、输出下界是多少、压缩指令要不要补保真要求）；reclaim 管**内容**（工具结果进历史前的净化与有界化、工具定义面折叠、前缀稳定化）。

**③ 缺了对方会怎样。**

| 只装 | 结果 |
|---|---|
| 只有 aux-degrade | 一切照常工作。辅助调用省下了、压缩摘要不会被截断。但工具结果不会被净化与有界化，长结果原样进历史 |
| 只有 reclaim | 一切照常工作。但辅助调用仍会烧满思考预算、压缩摘要仍可能被静默截断——reclaim 只会在日志里打 `[reclaim/summary-audit] ⚠️ 摘要缺 N/8 段` 提醒你，**它自己不会去改摘要** |

**④ 两者互不依赖。** aux-degrade 只 import 官方的 `@deepseek-ai/schemastery`，不 import reclaim，也不探测它装没装。**任何一个都能单独安装并正常工作**——这也是为什么它们是两个仓库而不是一个。

**⑤ 一句话。** reclaim 让「上下文不要变胖」，aux-degrade 让「该短的地方真的短」。两个一起装，上下文治理才是完整的。

### 🔗 与 `dsh-composer-launcher`

无直接耦合。

### 🔗 与 `dsh-capability-composer`

无直接耦合。

---

## FAQ

<details>
<summary><b>它会把主对话的思考强度也降下来吗？</b></summary>

不会。判据全部指向「辅助调用」：要么用途在名单里，要么来源插件在名单里，要么这次调用连 `purpose` 都没声明且没有工具。主对话调用三样都不沾。而且**如果调用方自己显式设了 `reasoningEffort`，本插件一律放行**——不覆盖任何人的明确意图。
</details>

<details>
<summary><b>`enabled: false` 能完全关掉它吗？</b></summary>

不能。`enabled` 只控制第 1 件（降思考强度）。第 2–4 件在任何配置下都会执行。这不是 bug——那三件修的是「上游插件省略了必填信息」这类问题，关掉它们会让上游继续出问题。真想逐项关：`DSH_AUX_MAXTOKENS_FLOOR=0` 关第 2 件，`noTools: false` 关第 4 件，第 3 件没有单独开关。
</details>

<details>
<summary><b>为什么默认就认 `dsh-prompt-enhance`？</b></summary>

因为它发起调用时不传 `purpose`，只靠用途判据识别不到它。而它又恰好是受这个问题影响最重的插件——不识别的话它会继承高档位思考强度，输出预算被推理吃光，表现为大量 502 和半个响应。
</details>

<details>
<summary><b>装完要重启吗？</b></summary>

要。宿主侧插件在 DSH 启动时装载。
</details>

<details>
<summary><b>支持网页版 DSH 吗？</b></summary>

支持。本插件只挂 Cordis 的 `llm/stream` 瀑布接缝，不依赖任何 Electron 或桌面专属能力。**只要是 DSH，桌面版和网页版都能用。**
</details>

---

## 仓库结构

```
dsh-aux-degrade/
├── index.js            # 全部实现（单文件，无外部依赖）
├── cordis.patch.yml    # DSH 插件清单补丁
├── package.json
├── verify.mjs          # 离线自检：node verify.mjs
├── README.md           # English
└── README.zh-CN.md     # 简体中文
```

## 自检

```bash
node verify.mjs
```

离线运行、不写盘。检查清单字段、语法、有没有混进私钥或备份文件、运行时代码里有没有写死的机器路径。

## License

[MIT](LICENSE) © 2026 夏目 ([xiamubumu](https://github.com/xiamubumu))
