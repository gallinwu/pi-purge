---
title: pi-purge preset 说明
---

# preset 放这里

这个目录下的每个 `*.md` 都是一个 preset，内容会**原样**注入系统提示词。

## 怎么被选中

按 `config.json` 里的 `modelPresets` 规则，第一条 glob 匹配当前模型的生效：

```json
{
  "modelPresets": [
    { "match": "deepseek/*",   "preset": "deepseek.md" },
    { "match": "*claude*",     "preset": "claude.md" },
    { "match": "google/gemini-2.5-pro", "preset": "gemini-pro.md" }
  ]
}
```

- `match` 对的是 `provider/modelId`，例如 `deepseek/deepseek-chat`
- `*` 匹配任意一段，`?` 匹配单个字符，大小写不敏感
- 想临时钉死某个 preset 用 `/purge preset <文件名>`，`/purge preset auto` 取消
- 没有 `modelPresets` 匹配时，只注入 `prompt-inject.md`

## 注意

- 只放在这个目录下的 `.md` 才被识别，`/purge preset` 只能指定本目录文件
- 内容是纯文本注入，**不要**自己包 `<project_instructions>`、`<|im_start|>` 之类的
  外层标签——模型会把它当成「会话里塞进来的项目说明」而拒绝扮演
