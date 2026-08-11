# 402v HTML Kit

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/GlauconAI/402v-html-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/GlauconAI/402v-html-kit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## 一次构建，随处打开，离线可验。

402v HTML Kit 可以把 Markdown 和结构化 JSON 编译成确定性、可自包含的
HTML 成品。最终结果只有一个可携带文件：阅读者不需要服务器，构建完成后
不需要安装 Node.js、npm 或外部 runtime；经过 contract-v2 验证的成品不包含
活动的外部资源依赖。

它适合长期笔记、AI Agent 报告、交互式数据简报、项目归档，以及任何希望
在构建环境消失后依然能够阅读和验证的交付物。

```text
Markdown 或 manifest + JSON
          ↓
确定性构建 + 受信任主题
          ↓
contract-v2 验证
          ↓
一个原子写入、可离线打开的 HTML 文件
```

## 为什么使用 402v HTML Kit？

- **交付一个文件，不必部署网站。** 脚本、样式、本地图片、canonical data
  和交互运行时都嵌入成品。
- **默认追求确定性。** 相同的合规源文件、数据、renderer 和 theme 会生成
  相同字节。
- **输出可以验证。** verifier 会检查契约、source hash、canonical data、
  顺序、资源限制、外部活动资源、不安全标记、横向溢出保护和交互启动状态。
- **同时支持阅读与交互。** 可以从 Markdown 生成干净的阅读页面，也可以
  构建带搜索、筛选、计数、deep link 和稳定数据块的交互报告。
- **更新是原子的。** 构建失败不会破坏原文件；覆盖必须显式声明，交互数据
  可以按 block ID 稳定更新。
- **视觉层可替换。** 中性的 compiler 与 artifact contract 不依赖 402v 官方
  theme。
- **适合自动化。** 每个操作型 CLI 命令只输出一个 JSON 值，并提供稳定错误码。

## 包结构

这个 npm workspaces monorepo 包含三个独立版本的包：

| 包 | 职责 |
| --- | --- |
| `@402v/html-kit-core` | 中性 builder、artifact contract、canonical data、验证、资源限制与原子写入 |
| `@402v/html-kit-cli` | `402v-html-kit` CLI、受限 worker、manifest 加载、theme 解析与结构化终端输出 |
| `@402v/theme-402v` | 402v 官方视觉主题，也是 CLI 默认主题 |

构建环境支持 Node.js `^22.13.0 || >=24.0.0` 和 npm 10 或更高版本。
生成的 HTML 不依赖 Node.js 或 npm 才能运行。

## 从源码快速开始

在 npm 正式发布前，使用仓库锁定的依赖：

```sh
git clone https://github.com/GlauconAI/402v-html-kit.git
cd 402v-html-kit
npm ci
npm exec -- 402v-html-kit --help
```

### 构建阅读笔记

先准备 Markdown：

```md
---
title: 现场笔记
description: 一份可以长期离线阅读的记录。
---

# 发生了什么

成品会包含自己的视觉样式与本地图片。
```

上面的片段展示输入格式；仓库已经提供可直接运行的
`examples/note/input.md`。执行构建与验证：

```sh
npm exec -- 402v-html-kit build examples/note/input.md \
  --output examples/note/output.html --force

npm exec -- 402v-html-kit verify examples/note/output.html
```

成功结果是机器可读的（下方为简写，实际结果还包含 `command` 与
`sourceHash`）：

```json
{"ok":true,"contractVersion":2,"mode":"note","dataBlockIds":[],"issues":[]}
```

note 成品不包含 runtime 或 consumer script，可以直接通过浏览器的 `file://`
打开。

### 构建交互式成品

interactive mode 使用受信任的本地 manifest、具名 JSON 数据块和本地
renderer。下面的最小 manifest 与仓库中的
`examples/interactive/artifact.mjs` 结构一致；同目录已包含
`data.json` 与 `renderer.mjs`：

```js
export default {
  contractVersion: 2,
  mode: "interactive",
  rootDirectory: ".",
  metadata: {
    title: "离线项目简报",
    description: "一份确定性的数据报告。",
    eyebrow: "项目简报",
    lang: "zh-CN",
  },
  dataBlocks: [{ id: "dashboard", source: "./data.json" }],
  renderer: "./renderer.mjs",
  styles: [],
  scripts: [],
  svgAssets: [],
  requiredDataBlocks: ["dashboard"],
  theme: "@402v/theme-402v",
};
```

renderer 导出 `renderArtifact`，并返回受限的 HTML slots：

```js
export function renderArtifact({ data }) {
  const count = data.dashboard.items.length;
  return {
    navigation: '<nav><a href="#overview">概览</a></nav>',
    heroSupplementary: `<p>共跟踪 ${count} 项</p>`,
    mainSections: '<section id="overview"><h2>概览</h2></section>',
    rail: "",
    footer: "<p>本地构建并完成验证。</p>",
  };
}
```

builder 默认会在内部渲染两次，并在字节不一致时拒绝输出。因此只需一次构建
命令即可执行精确字节确定性检查；之后再验证全部必需数据块：

```sh
npm exec -- 402v-html-kit build-artifact examples/interactive/artifact.mjs \
  --output examples/interactive/output.html --force

npm exec -- 402v-html-kit verify examples/interactive/output.html \
  --required-block dashboard
```

浏览器脚本可以通过中性 runtime 读取冻结的 canonical data，无需依赖 theme：

```js
const dashboard = window.__htmlKitArtifact.getData("dashboard");
const ids = window.__htmlKitArtifact.dataIds();
```

无需手工修改 HTML，就能按稳定 block ID 更新数据：

```sh
cp examples/interactive/data.json /tmp/402v-data.next.json

npm exec -- 402v-html-kit update-data examples/interactive/output.html \
  --manifest examples/interactive/artifact.mjs \
  --id dashboard \
  --input /tmp/402v-data.next.json \
  --force
```

仓库内的[完整 interactive 示例](examples/interactive/)包含 manifest、renderer
和数据集。

### 使用自定义主题

theme 是实现 Theme Contract v1 的受信任本地构建模块。选择前必须审查模块
及其依赖图：

```sh
npm exec -- 402v-html-kit build examples/custom-theme/input.md \
  --theme ./examples/custom-theme/artifact-theme.mjs \
  --output examples/custom-theme/output.html

npm exec -- 402v-html-kit verify examples/custom-theme/output.html
```

theme 优先级固定为：

1. 显式 `--theme`；
2. manifest 中的 `theme`；
3. 官方默认 `@402v/theme-402v`。

core 不负责解析 theme specifier。使用程序 API 时，由调用者自行 import Theme
Contract v1 对象并传给 core。

## 从 npm 安装

`0.1.0` 正式发布到 npm 后，只使用 CLI 的项目可以锁定精确版本：

```sh
npm install --save-dev --save-exact @402v/html-kit-cli@0.1.0
npm exec -- 402v-html-kit --help
```

CLI 会声明兼容的 core 与官方 theme 依赖。程序 API 使用者直接安装精确的
兼容版本：

```sh
npm install --save-exact \
  @402v/html-kit-core@0.1.0 \
  @402v/theme-402v@0.1.0
```

```js
import { buildNote, verifyArtifact } from "@402v/html-kit-core";
import theme from "@402v/theme-402v";

await buildNote({
  inputPath: "input.md",
  outputPath: "output.html",
  theme,
});

await verifyArtifact({ path: "output.html" });
```

## CLI 参考

```text
402v-html-kit init <directory> --title <title> [--theme <specifier>] [--force]
402v-html-kit build <input.md> [--theme <specifier>] [--output <html>] [--force]
402v-html-kit build-artifact <manifest.mjs> [--theme <specifier>] [--output <html>] [--preserve-data-from <html>] [--force]
402v-html-kit update-data <artifact.html> --manifest <manifest.mjs> --id <id> --input <json> [--theme <specifier>] [--output <html>] [--upgrade-contract 2] [--force]
402v-html-kit verify <artifact.html> [--required-block <id>]...
```

`--help` 是唯一的人类文本输出。每个操作型命令只输出一个 JSON 对象。失败时
以非零状态退出，并提供稳定的
`{ "ok": false, "error": { "code", "message", "details"? } }` 结构；程序
应根据 `error.code` 分支，不要匹配 message 文本。

parser 目前接受 `--preserve-data-from`，但命令会以
`COMMAND_UNAVAILABLE` fail closed；它不是迁移或数据保留路径。

## “离线可验”具体意味着什么？

经过验证的 contract-v2 成品：

- 只包含内联脚本和样式；
- 最终图片使用 data URL；
- 拒绝 frame、object、媒体资源、module import、不安全 URL、事件属性、
  外部 SVG 引用和 CSS 外部依赖；
- 检查 canonical JSON、source hash、顺序、唯一中性根节点、资源上限、
  横向溢出保护与交互启动；
- 无需网络即可打开和验证；只使用内嵌数据的交互逻辑可以完整离线运行。

被动链接可以保留。点击 `https:`、`mailto:`、`tel:`、fragment 或相对链接，
属于用户主动导航。
Markdown 中的远程图片会转换成被动链接，不会生成主动请求远程图片的 `<img>`。

consumer JavaScript 属于受信任本地代码，不是受限能力沙箱。它可以在启动后
主动调用 `fetch`、执行页面导航或使用其他浏览器网络 API。verification 不承诺
阻止这些动作；如果成品必须保持网络静默，应审查 consumer script 及其依赖。

contract-v1 仍可用于兼容验证，但 v1 note 可能包含历史远程资源，因此不享有
contract-v2 的严格离线保证。应保留既有 v1 字节，或从源文件重建为 v2。

## 信任边界

Markdown 和 JSON 被视为不可信数据，会经过解码、解析、资源限制、
canonicalization 与转义。theme、manifest、renderer、consumer JavaScript/CSS
及已安装依赖属于受信任本地代码，不在沙箱中运行。verification 约束最终成品，
不会让未经审查的模块自动变安全。

402v HTML Kit 的边界止于一个通过验证的本地文件。CMS / database 写入、账号、
可见性、托管、部署和网站发布均明确不在本项目范围内。

## 外部发布 Gate

源码已经满足本地 release-ready 条件，但不能假设外部资源已经存在。正式发布前，
GlauconAI 必须控制 public GitHub 仓库、npm 的 `@402v` scope，以及三个包名。

GitHub 的 `v*.*.*` ruleset 必须把 release tag 设为不可变的 signed annotated
tag：禁止更新和删除，且只允许指定 release maintainer 或显式 bypass actor 创建。

三个 npm 包都必须把 trusted publisher 设置为仓库
`GlauconAI/402v-html-kit`、workflow `.github/workflows/release.yml` 和 environment
`npm`。workflow 支持断点恢复；registry 中若已有同版本包，只有 integrity 与
provenance 都匹配已验证源码时才会接受，否则 fail closed。仅根工作区使用的
`sigstore@4.1.1`（Apache-2.0）不会进入生产包。

## 文档

- [架构与精确 public API](docs/architecture.md)
- [Artifact Contract v2](docs/artifact-contract-v2.md)
- [Theme Contract v1](docs/theme-contract-v1.md)
- [从内部 contract v1 迁移](docs/migration-from-internal-v1.md)
- [安全与资源模型](docs/security-model.md)
- [源码 provenance](docs/provenance.md)
- [生产依赖许可证](docs/dependency-licenses.md)
- [Release checklist](docs/release-checklist.md)

## 贡献与安全

提交改动前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全漏洞必须按照
[SECURITY.md](SECURITY.md) 私下报告，不要创建公开 Issue。面向用户的变化应记录
在 [CHANGELOG.md](CHANGELOG.md) 中。

## License

[MIT](LICENSE) © 2026 GlauconAI。
