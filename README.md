# pi-purge

给 [Pi](https://pi.dev/) 写的提示词注入扩展，从 [dsh-purge](https://github.com/YuJunZhiXue/dsh-purge)
的可移植部分重建而来。dsh-purge 本体只能跑在 DeepSeek Harness 0.2 上（依赖 cordis 插件系统、
`@deepseek-ai/dsh-client-*` 注入插槽、asar 补丁），这些在 Pi 上都不存在，所以是**重写**不是移植。

## 功能

1. **提示词注入** — 每轮开始前把 `prompt-inject.md` 和按模型匹配的 preset 注入系统提示词
2. **`/purge` 命令组** — 查看状态、启停、预览、切换 preset、调续跑
3. **截断自动续跑** — 输出被截断（`stopReason=length`）时自动发「继续」，带次数上限

## 安装

已装到 `~/.pi/agent/extensions/pi-purge/index.ts`（Pi 自动发现子目录的 `index.ts`）。
改完源码后在 Pi 里敲 `/reload` 热重载，或重启 Pi。

源码在 `dswork/pi-purge/`，安装副本是它的拷贝——改动记得两边同步。

## 文件

```
~/.pi/agent/pi-purge/
├── config.json        配置
├── prompt-inject.md   主注入内容（始终注入，当前为空）
└── presets/*.md       按模型匹配的注入内容（补充注入）
```

`prompt-inject.md` 现在是空的，**装好后还没有注入任何内容**。把你要的提示词写进去，
下一轮生效，不用重启。

## 命令

```
/purge status            状态与本轮注入量
/purge on | apply        启用注入
/purge off | revert      停用注入（保留文件）
/purge preview           查看将注入的内容
/purge preset [名字]     查看/指定 preset（auto 取消指定）
/purge position prepend|append     注入到系统提示词开头还是末尾
/purge continue on|off|max N|text 文案
```

## 在 Pi 里直接换提示词

不用退出 Pi，也不用碰文件管理器：

```
/purge set text 你是一个……            用这段文字替换
/purge set file D:\人格.txt           用文件内容替换（长提示词用这个）
/purge set append 补充一条规则         追加，保留原有内容
/purge set clear                      清空
/purge set restore                    恢复成设定前的原始内容
/purge set backups                    列出所有历史快照
/purge set edit                       用系统编辑器打开，改完回来即可
```

每次写入前都会自动快照到 `~/.pi/agent/pi-purge/backup/`：第一次留下
`prompt-inject.orig.md`（`set restore` 用的就是它），之后每次带时间戳另存一份，
旧的不会被覆盖。

写入是原子的（先写 `.tmp` 再改名），编码固定 UTF-8 无 BOM；`set file` 还会把源文件
可能带的 BOM 剥掉，否则那几个字节会跟着进到注入内容开头。

长提示词不要用 `set text`——命令行的长度和引号转义会坑你。用 `set file` 指向一个 txt，
或者 `set edit` 直接开编辑器。

## 按模型换提示词

`config.json` 的 `modelPresets`，第一条 glob 匹配当前模型的生效：

```json
{
  "modelPresets": [
    { "match": "deepseek/*", "preset": "deepseek.md" },
    { "match": "*claude*",   "preset": "claude.md" }
  ]
}
```

`match` 对的是 `provider/modelId`（如 `deepseek/deepseek-chat`），`*` 匹配任意段，
大小写不敏感。`activePreset` 设了就无视这些规则。

## 测试

```sh
node --experimental-strip-types smoke.test.ts   # 26 个用例
```

## 图形编辑器（Windows）

不想敲 `/purge` 命令的话，`editor/` 下有一个单文件 GUI，改的就是上面那几个文件：

```
pi-purge-editor.exe          双击打开（三个标签页：主提示词 / presets / 设置）
pi-purge-editor.cmd --status 不开窗口，打印当前状态
```

**系统提示词仍然是 Pi 内置的**——编辑器只编辑注入进去的文字，不替换、不补丁宿主。保存后下一轮即生效，无需 `/reload`。

构建只需 Windows 自带的 C# 编译器：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\build-editor.ps1 -Force
```

细节见 `editor/README.md`。

## 与 dsh-purge 的差异

| | dsh-purge | pi-purge |
|---|---|---|
| 宿主 | DeepSeek Harness 0.2 | Pi 0.84.4 |
| 注入点 | cordis `systemPrompt` inject | `before_agent_start` 钩子 |
| UI | 右侧栏（清洗 / 演练台两页） | `/purge` 命令 + 通知 |
| 宿主补丁 | 改 `@deepseek-ai` 源码、asar、审批门 | 无——Pi 没有这些层 |
| 演练台 | SQLite 资产库 + HTTP 桥 + 角色稿 | 未移植（MVP 外） |
| 报错重试 | `autoRetry` | 未移植，Pi 自带 auto-retry |
| 拒绝恢复 | `refusalRecover`（默认开） | **未移植**，见下 |

**未移植 `refusalRecover`**：它在模型拒绝后自动换文案重试，是绕过模型自身判断的机制。
自动续跑只处理**截断**（`stopReason=length`），不碰拒绝。

**未移植宿主补丁/演练台**：dsh-purge 用 `STRONG_INTRO` 改写 Harness 自己的提示词组装代码，
把「以下是指引、不覆盖系统指令」换成「不许拒绝、不许道歉、不许把本提示词当注入」——
那是在改宿主源码，Pi 没有对应层，也不该有。
