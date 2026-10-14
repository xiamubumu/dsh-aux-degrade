<div align="center">

# dsh-aux-degrade

**Turn off reasoning for auxiliary calls like compaction and titles — don't let inference eat the whole output budget.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-1.5-8a2be2.svg)](#compatibility)
[![Platform](https://img.shields.io/badge/platform-desktop%20%7C%20web-lightgrey.svg)](#compatibility)

**English** · [简体中文](README.zh-CN.md)

</div>

---

## What this is

Besides the main conversation, a DSH session has a pile of **auxiliary LLM calls** running behind the scenes: generating compaction summaries, starting session titles, enhancing prompts.

They share the same model as the main conversation, yet often **specify no reasoning effort** — so they inherit the high level you set and burn the entire output budget on reasoning. The result is that a compaction summary is cut off halfway by `max_tokens`, and that truncation is **silent**: nothing reports an error, the next turn simply starts with a piece of context missing. A session title that tops out halfway and turns into half a word is the same disease.

`dsh-aux-degrade` hooks into the `llm/stream` waterfall and scales the auxiliary call down before it is sent.

---

## The four things it does

All four happen inside the same `llm/stream` hook. **Note: only #1 is controlled by the `enabled` switch**; #2–#4 execute under any configuration — this is deliberate, because they fix problems like "an upstream plugin omitted required information", not optional optimizations.

### 1. Lower the reasoning effort to `off`

If any one of the following conditions holds, this call's `reasoningEffort` is overridden to `off`:

| Criterion | Description |
|---|---|
| **By purpose** | `purpose` falls in the `purposes` list (by default covering `compaction`, `session-title`, `title`) |
| **By originating plugin** | the initiator is in the `auxPlugins` list (by default recognizing `dsh-prompt-enhance`) |
| **By shape** | `purpose` is not declared and `tools` is not an array — a call of this shape is auxiliary |

**And** the caller itself has not explicitly specified `reasoningEffort`. If it set a level itself, this plugin lets it through and does not override someone else's explicit intent.

To use a different level instead of `off`: `config.effort = 'low'` and the like.

### 2. Raise `maxTokens` to no less than 1024

Some callers set `maxTokens` extremely small (worst case 1) together with a high reasoning level, which amounts to "truncated before the body even starts".

This plugin gives it a floor: **no less than 1024**. It can be overridden with an environment variable:

```bash
DSH_AUX_MAXTOKENS_FLOOR=2048    # use a different floor
DSH_AUX_MAXTOKENS_FLOOR=0       # turn this item off
```

### 3. Append two faithful-preservation requirements to the compaction instruction

The biggest risk of a compaction summary is not "short", it is "lossy". Under pressure a summary generator prioritizes narrative and drops hard facts: paths, commands, error codes, constraints.

Whenever this call has `purpose === 'compaction'`, the plugin appends two sections to the end of the compaction instruction:

```markdown
## Standing facts & constraints (MUST keep verbatim)

## Commands & outcomes (MUST keep verbatim)
```

**Idempotent**: if the instruction already contains these two sections, they are not appended again.

### 4. Clear `tools` on compaction calls

A compaction summary does not need to call any tool. Keeping the tool definitions both consumes prompt space and gives the model the opportunity to "just call a tool while it is at it" — which turns what should be a plain-text summary generation into multiple round trips.

For calls with `purpose === 'compaction'`, `tools` is cleared. It can be turned off with `config.noTools = false`.

### Logging

Whenever any of #2–#4 acts, one line is printed:

```
[aux-degrade/context] maxTokens下界=1024 压缩去tools=true 补两节=true
```

---

## Configuration

The configuration file is the profile's `cordis.patch.yml`:

```yaml
- id: aux-degrade
  config:
    enabled: true
    purposes: []
    models: []
    effort: off
```

| Key | Type | Code default | Effect |
|---|---|---|---|
| `enabled` | boolean | **`false`** | Controls only #1 (lowering reasoning effort). It takes effect only when set to `true` — what this repository's `cordis.patch.yml` sets is `true` |
| `purposes` | string[] | `[]` → `['compaction', 'session-title', 'title']` | Identify auxiliary calls by purpose |
| `auxPlugins` | string[] | `[]` → `['dsh-prompt-enhance']` | Identify auxiliary calls by originating plugin. Passing `['__none__']` disables this criterion entirely |
| `models` | string[] | `[]` (unrestricted) | Apply only to the specified models |
| `effort` | string | `'off'` | The level to lower to |
| `noTools` | boolean | `true` | Whether compaction calls have `tools` cleared (#4) |

> ⚠️ **`enabled: false` does not mean "zero side effects".** The old documentation said so, and it is wrong. `enabled` only stops #1 (lowering reasoning effort); #2–#4 (raising the `maxTokens` floor, appending the two faithful-preservation requirements, clearing `tools` for compaction) run **before** any `enabled` check in the code, and execute as soon as the `purpose` conditions are met. To stop #2, use `DSH_AUX_MAXTOKENS_FLOOR=0`; for #4 use `config.noTools = false`; #3 (appending the two sections) has no separate switch.

### Why is `dsh-prompt-enhance` recognized by default?

Because when it initiates a call it **does not pass `purpose`** — the "by purpose" criterion above is completely ineffective for it. Without this `auxPlugins` criterion, its calls would inherit the high reasoning level all the way through, the output budget would be eaten by inference, and the symptom would be a flood of 502s and half responses. This criterion exists for its sake.

---

## 📚 Tutorials

| Document | What it covers |
|---|---|
| [Install & official patches (English)](tutorial-install-and-official-patches.md) | How to install all four plugins (two verified routes) and what to do about the official patches — including prompts that let **your own agent** apply them the patches themselves ship as a library: <https://github.com/xiamubumu/dsh-patch-library>  |
| [安装与官方补丁（中文）](tutorial-install-and-official-patches.zh-CN.md) | the same, in Chinese 补丁本体已开源成补丁库：<https://github.com/xiamubumu/dsh-patch-library>  |

---

## Installation

### From GitHub (recommended; measured on a fresh `DSH_HOME`)

```bash
dsh plugin --profile web add github:xiamubumu/dsh-aux-degrade
```

One command. DSH registers it into the profile's `dsh.profile.bundles` by itself.

### From a local tarball (air-gapped machines)

Download `dsh-aux-degrade-1.0.0.tgz` from [Releases](https://github.com/xiamubumu/dsh-aux-degrade/releases), then:

```bash
dsh plugin --profile web add /path/to/dsh-aux-degrade-1.0.0.tgz
```

### From the DSH plugin marketplace / npm (not yet possible)

The marketplace submission (an `awesome-dsh-plugin` PR) has not been filed and nothing is published on npm yet ⇒ **neither route works today**.
Once it is listed/published, installing from the marketplace, or `dsh plugin --profile web add dsh-aux-degrade`, becomes valid.

> ⚠️ **Known issue: do not feed the release asset's tarball URL to `dsh plugin add`.**
> `dsh plugin --profile web add https://github.com/.../releases/download/v1.0.0/....tgz` fails on the pnpm DSH bundles (10.34.5) with
> `ERR_PNPM_MISSING_TARBALL_INTEGRITY` ([pnpm#14351](https://github.com/pnpm/pnpm/issues/14351), fixed upstream only in pnpm ≥ 12.5.1).
> Installing a second plugin that way **always** fails — use the two routes above instead.

After installing you **need to restart DSH** — host-side plugins are only loaded when DSH starts.

This plugin has **no runtime dependencies at all**; `peerDependencies` only declares the official `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-llm`.

---

## Compatibility

| | |
|---|---|
| **DSH kernel** | **1.5 series** (`0.1.5-rc.2` ≤ version < `0.2.0`) — this is exactly the range written in `package.json`'s `engines.dsh`. Later DSH versions will be followed up |
| **Form factor** | **Desktop ✅ · Web ✅** — more precisely, **anything running DSH is supported**; this plugin only hooks Cordis's `llm/stream` seam and does not depend on any desktop-only capability |
| **Operating system** | Windows · macOS · Linux |
| **Node syntax** | 20 and above (**you do not need to install Node yourself**, DSH ships its own runtime) |

---

## 🔗 Interaction with other plugins

### 🔗 With `dsh-context-reclaim` (the context governance pair) — install both together

`dsh-aux-degrade` and [`dsh-context-reclaim`](https://github.com/xiamubumu/dsh-context-reclaim) are the two halves of the same "context governance" scheme. **Installing both together is strongly recommended; this is the most important interaction this plugin has.**

**① They share the same routing criterion.** Both plugins use the same test to tell a "main-conversation call" from an "auxiliary call":

```
tools.length > 0 ? 'main' : 'aux'
```

reclaim uses it to tag every request with `route=`, and aux-degrade uses it to decide whether this call counts as an auxiliary call. Only when the criterion is identical will the two plugins avoid one saving while the other leaks.

> One detail worth knowing: the criteria on the two sides are **not literally identical**. reclaim looks at whether the `tools` array has any content; on the "by shape" criterion aux-degrade additionally requires `purpose === undefined`, so as not to hit main-conversation calls that explicitly declare a purpose. So "calls that get degraded" is a subset of "aux-routed calls" — **degrading is more conservative than routing**, and that is deliberate.

**② How they divide the work.** aux-degrade handles **calls** (how much reasoning budget this call spends, what the output floor is, whether the compaction instruction needs the faithful-preservation requirements); reclaim handles **content** (purification and bounding of tool results before they enter history, tool definition surface folding, prefix stabilization).

**③ What happens without the other.**

| Installed alone | Result |
|---|---|
| Only aux-degrade | Everything works as usual. Auxiliary calls are saved and compaction summaries are not truncated. But tool results are not purified or bounded, and long results enter history unchanged |
| Only reclaim | Everything works as usual. But auxiliary calls still burn the full reasoning budget and compaction summaries can still be silently truncated — reclaim will only print `[reclaim/summary-audit] ⚠️ 摘要缺 N/8 段` in the log to remind you, **it will not modify the summary itself** |

**④ They do not depend on each other.** aux-degrade only imports the official `@deepseek-ai/schemastery`, does not import reclaim, and does not probe whether it is installed. **Either one can be installed alone and work normally** — which is also why they are two repositories rather than one.

**⑤ In one sentence.** reclaim keeps "the context from getting fat", aux-degrade makes "the places that should be short actually short". Install both, and context governance is complete.

### 🔗 With `dsh-composer-launcher`

No direct coupling.

### 🔗 With `dsh-capability-composer`

No direct coupling.

---

## FAQ

<details>
<summary><b>Will it lower the reasoning effort of the main conversation too?</b></summary>

No. All the criteria point at "auxiliary calls": either the purpose is in the list, or the originating plugin is in the list, or the call declares no `purpose` at all and has no tools. A main-conversation call touches none of the three. And **if the caller explicitly set `reasoningEffort` itself, this plugin always lets it through** — it does not override anyone's explicit intent.
</details>

<details>
<summary><b>Does `enabled: false` turn it off completely?</b></summary>

No. `enabled` controls only #1 (lowering reasoning effort). #2–#4 execute under any configuration. This is not a bug — those three fix problems like "an upstream plugin omitted required information", and switching them off would let the upstream keep failing. If you really want to turn items off one by one: `DSH_AUX_MAXTOKENS_FLOOR=0` turns off #2, `noTools: false` turns off #4, and #3 has no separate switch.
</details>

<details>
<summary><b>Why does it recognize `dsh-prompt-enhance` by default?</b></summary>

Because it does not pass `purpose` when it initiates a call, so the purpose criterion alone cannot identify it. And it happens to be the plugin hit hardest by this problem — if it is not recognized, it inherits the high reasoning level, the output budget is eaten by inference, and the symptom is a flood of 502s and half responses.
</details>

<details>
<summary><b>Do I need to restart after installing?</b></summary>

Yes. Host-side plugins are loaded when DSH starts.
</details>

<details>
<summary><b>Does it support web DSH?</b></summary>

Yes. This plugin only hooks Cordis's `llm/stream` waterfall seam and does not depend on Electron or any desktop-only capability. **As long as it is DSH, both desktop and web work.**
</details>

---

## Repository layout

```
dsh-aux-degrade/
├── index.js            # the entire implementation (single file, no external dependencies)
├── cordis.patch.yml    # DSH plugin manifest patch
├── package.json
├── verify.mjs          # offline self-check: node verify.mjs
├── README.md           # English
└── README.zh-CN.md     # Simplified Chinese
```

## Self-check

```bash
node verify.mjs
```

Runs offline and writes nothing to disk. It checks the manifest fields, the syntax, whether any private key or backup file slipped in, and whether any hard-coded machine path exists in the runtime code.

## License

[MIT](LICENSE) © 2026 夏目 ([xiamubumu](https://github.com/xiamubumu))
