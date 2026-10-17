# pi-purge prompt editor

一个 Windows 图形编辑器，改的就是 pi-purge 读的那几个文件——**系统提示词仍然是 Pi 内置的那份**，这个工具只负责往里面注入的文字。

不需要终端，不需要 Node，不需要装任何运行时：双击 `pi-purge-editor.exe` 就能用。

## 它改什么

```
%USERPROFILE%\.pi\agent\pi-purge\
├── config.json          开关、注入位置、preset 规则、自动续跑
├── prompt-inject.md     始终注入（主编辑器）
└── presets\*.md         按模型匹配时才注入
```

`prompt-inject.md` 对应「Main prompt」页，`presets\*.md` 对应「Presets」页，其余在「Settings」页。

保存即生效——**下一轮对话就用了，不用 `/reload`，也不用重启 Pi**。

## 三种打开方式

```
pi-purge-editor.exe                 双击，打开编辑器
pi-purge-editor.exe --silent        不开窗口，打印当前状态（可重定向）
pi-purge-editor.exe --dump          额外把配置的序列化结果打印出来
pi-purge-editor.cmd --status        同上，cmd 封装，适合放进其他脚本
pi-purge-editor.cmd --folder        直接打开数据目录
```

## 安全写入

三个文件都用「写临时文件 → 删除原件 → 改名」的方式落盘，所以编辑过程中崩溃不会把提示词截断成半截。编码统一 UTF-8 无 BOM，和 pi-purge 期望的一致。

`config.json` 的序列化格式与 pi-purge 自己写出来的**逐字节相同**（已验证 1129 字节完全一致），所以用这个编辑器存一次不会产生无意义的 diff。

## 构建

需要 Windows 自带的东西就够了：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\build-editor.ps1 -Force
```

用 .NET Framework 4.x 自带的 `csc.exe` 编译 `editor/*.cs`，输出到 `dist/`。

## 一个已知取舍

exe 编译为 **console 子系统**——这是 `--silent` 的输出能被重定向、能被 CI 断言的前提（GUI 子系统 exe 的 stdout 一旦重定向就彻底丢失，实测确认过）。代价是双击启动时可能看到控制台窗口一闪。GUI 模式第一件事就是 `FreeConsole()` 把它摘掉，所以不会留一个黑窗口在那里。

想要绝对没有闪烁，就只双击 `pi-purge-editor.cmd`——它用 `start` 拉起 exe，不经过当前控制台。

## 与 dsh-purge 的关系

pi-purge 本身是从 dsh-purge 的可移植部分重写的。这个编辑器只操作**数据文件**，不碰任何宿主源码，也不做 dsh-purge 里那套 asar / 提示词组装代码的补丁。
