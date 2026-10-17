# pi-purge 一键注入（双击即用）

把提示词写进 `提示词.txt`，双击 `1-注入.cmd`。就这么两步。

系统提示词仍然是 Pi 内置的那份——这里换的只是**注入进去的文字**。不需要改 Pi 的任何文件，不需要 Node，也不用打开终端。

## 怎么用

1. 用记事本打开 `提示词.txt`，粘贴你的提示词，保存（编码留 UTF-8）
2. 双击 **`1-注入.cmd`**
3. 回 Pi 里对话，下一轮就生效

```
1-注入.cmd      把 提示词.txt 写入 pi-purge（自动备份）
2-恢复.cmd      恢复到注入前的原始内容
3-状态.cmd      看当前注入开关、位置、大小、备份数
4-备份列表.cmd  列出所有历史快照
```

## 换一份提示词

直接改 `提示词.txt` 再双击 `1-注入.cmd` 即可。**每次注入都会留一份带时间戳的快照**在
`~\.pi\agent\pi-purge\backup\`，旧的不会被覆盖，随时可以翻回去。

第一次注入时会额外保存 `prompt-inject.orig.bak`——那是你原始的提示词，`2-恢复.cmd` 用的就是它。

## 想确认真的生效了

在 Pi 里敲：

```
/purge preview
```

能看到拼好的完整注入内容。或者双击 `3-状态.cmd`，看「注入开关」是不是「开」。

## 命令行用法

不想点鼠标也可以：

```powershell
powershell -ExecutionPolicy Bypass -File .\purge.ps1 install
powershell -ExecutionPolicy Bypass -File .\purge.ps1 status
powershell -ExecutionPolicy Bypass -File .\purge.ps1 restore
powershell -ExecutionPolicy Bypass -File .\purge.ps1 list
powershell -ExecutionPolicy Bypass -File .\purge.ps1 open
```

换文件、顺手改注入位置：

```powershell
.\purge.ps1 install -File D:\我的提示词.txt -Position prepend
```

`-Position` 接受 `prepend`（放系统提示词开头）或 `append`（放末尾，默认）。

## 三个容易踩的坑（都已在代码里处理）

**编码**。`prompt-inject.md` 写成 UTF-8 带 BOM 的话，注入内容开头会多出三个不可见字节，有些模型会把它当成正文的一部分。这里统一写 UTF-8 无 BOM。

**原子写入**。先写临时文件再替换，中途断电或崩溃不会把提示词截成半截。

**PowerShell 脚本必须带 BOM**。Windows PowerShell 5.1 读无 BOM 的 UTF-8 脚本时会按 GBK 解释，中文全变乱码进而语法报错。所以 `purge.ps1` 存成了 UTF-8 **带** BOM，而 `.cmd` 文件里一个字的中文都没有（cmd.exe 解析批处理时同样不走 UTF-8，`chcp 65001` 只管运行时输出）。这是照着你给的两个示例的做法：bat 里全英文，中文都放在 ps1 里。

## 目录结构

```
deploy/
├── 1-注入.cmd
├── 2-恢复.cmd
├── 3-状态.cmd
├── 4-备份列表.cmd
├── purge.ps1        实际逻辑
└── 提示词.txt       你编辑这个
```

数据写入位置：`%USERPROFILE%\.pi\agent\pi-purge\`
（设了 `PI_CODING_AGENT_DIR` 就跟着变，脚本会自动识别。）
