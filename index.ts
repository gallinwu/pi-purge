/**
 * pi-purge — Pi 的提示词注入扩展
 *
 * 三件事：
 *   1. 每轮开始前把 prompt-inject.md 与按模型匹配的 preset 注入系统提示词
 *   2. /purge 命令组：status / on / off / preview / preset / position / continue
 *   3. 输出被截断（stopReason=length）时自动发「继续」，带次数上限
 *
 * 数据目录：~/.pi/agent/pi-purge/
 *   config.json        配置
 *   prompt-inject.md   主注入内容（始终注入）
 *   presets/*.md       按模型匹配的注入内容（补充注入）
 *
 * 注入内容是纯文本，不包任何 <tag> 外壳——外层标签会被模型当成「会话里塞进来的
 * 项目说明」而被无视或引用它来拒绝扮演，这是 dsh-purge 上游踩过的坑。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Position = "prepend" | "append";

interface ModelPresetRule {
  /** glob，匹配 `provider/modelId`，* 匹配任意段，? 匹配单字符 */
  match: string;
  /** presets/ 下的文件名，例如 "deepseek.md" */
  preset: string;
}

interface PiPurgeConfig {
  enabled: boolean;
  position: Position;
  /** 显式指定的 preset；设了就无视 modelPresets */
  activePreset: string | null;
  modelPresets: ModelPresetRule[];
  autoContinue: boolean;
  continueMax: number;
  continueText: string;
}

const DEFAULT_CONFIG: PiPurgeConfig = {
  enabled: true,
  position: "append",
  activePreset: null,
  modelPresets: [],
  autoContinue: true,
  continueMax: 3,
  continueText: "继续",
};

// Respect PI_CODING_AGENT_DIR the way Pi itself does. Hard-coding ~/.pi/agent
// made the extension untestable and would write to the wrong place for anyone
// running Pi with a custom agent dir.
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR?.trim()
  ? path.resolve(process.env.PI_CODING_AGENT_DIR.trim())
  : path.join(os.homedir(), ".pi", "agent");
const DATA_DIR = path.join(AGENT_DIR, "pi-purge");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const INJECT_FILE = path.join(DATA_DIR, "prompt-inject.md");
const PRESETS_DIR = path.join(DATA_DIR, "presets");

/* ---------------------------------------------------------------- 配置读写 */

function ensureDataDir(): void {
  fs.mkdirSync(PRESETS_DIR, { recursive: true });
}

function loadConfig(): PiPurgeConfig {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<PiPurgeConfig>;
    const merged: PiPurgeConfig = { ...DEFAULT_CONFIG, ...(parsed ?? {}) };
    if (!Array.isArray(merged.modelPresets)) merged.modelPresets = [];
    if (merged.position !== "prepend" && merged.position !== "append") {
      merged.position = DEFAULT_CONFIG.position;
    }
    if (typeof merged.activePreset !== "string" || !merged.activePreset) {
      merged.activePreset = null;
    }
    merged.continueMax = clampInt(merged.continueMax, DEFAULT_CONFIG.continueMax, 0, 20);
    if (typeof merged.continueText !== "string" || !merged.continueText.trim()) {
      merged.continueText = DEFAULT_CONFIG.continueText;
    }
    return merged;
  } catch {
    return { ...DEFAULT_CONFIG, modelPresets: [] };
  }
}

function saveConfig(cfg: PiPurgeConfig): void {
  ensureDataDir();
  writeAtomic(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`);
}

/* ------------------------------------------------------------ 内容写入与备份 */

/**
 * Write through a temp file and swap, so an interrupted write cannot truncate the
 * injected prompt into a half sentence. UTF-8 without BOM -- a BOM would show up as
 * three invisible bytes at the head of the injected text.
 */
function writeAtomic(file: string, text: string): void {
  ensureDataDir();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

const BACKUP_DIR = path.join(DATA_DIR, "backup");

/**
 * Snapshot a content file before overwriting it. The first snapshot is kept as
 * `<name>.orig` so `/purge set restore` always has the pre-edit version, and every
 * write also leaves a timestamped copy so nothing is silently lost.
 */
function backupBeforeWrite(file: string): { orig: string | null; snap: string | null } {
  if (!fs.existsSync(file)) return { orig: null, snap: null };
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const base = path.basename(file, path.extname(file));
  const ext = path.extname(file);

  let orig: string | null = null;
  const origPath = path.join(BACKUP_DIR, `${base}.orig${ext}`);
  if (!fs.existsSync(origPath)) {
    fs.copyFileSync(file, origPath);
    orig = origPath;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 19);
  let snap: string | null = path.join(BACKUP_DIR, `${base}.${stamp}${ext}`);
  let n = 1;
  while (fs.existsSync(snap)) snap = path.join(BACKUP_DIR, `${base}.${stamp}-${n++}${ext}`);
  fs.copyFileSync(file, snap);
  return { orig, snap };
}

/** Resolve a user-supplied path: ~ expansion, then relative to cwd. */
function resolveUserPath(input: string, cwd: string): string {
  let p = input.trim();
  if (p === "~") p = os.homedir();
  else if (p.startsWith("~/") || p.startsWith("~\\")) p = path.join(os.homedir(), p.slice(2));
  if (!path.isAbsolute(p)) p = path.resolve(cwd, p);
  return p;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/* ---------------------------------------------------------------- 文件读取 */

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function listPresets(): string[] {
  try {
    return fs
      .readdirSync(PRESETS_DIR)
      .filter((name) => name.toLowerCase().endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}

/** 只认 presets/ 目录下、以 .md 结尾的纯文件名，挡掉路径穿越 */
function presetPath(name: string): string | null {
  const base = path.basename(String(name ?? "").trim());
  if (!base.toLowerCase().endsWith("." + "md")) return null;
  const full = path.join(PRESETS_DIR, base);
  if (path.dirname(full) !== path.resolve(PRESETS_DIR)) return null;
  return full;
}

function readPreset(name: string | null): string {
  if (!name) return "";
  const file = presetPath(name);
  return file ? readText(file) : "";
}

/* -------------------------------------------------------------- 模型匹配 */

function modelKeyOf(model: { provider?: string; id?: string } | undefined): string {
  if (!model) return "";
  const provider = model.provider ?? "";
  const id = model.id ?? "";
  if (!provider && !id) return "";
  return `${provider}/${id}`;
}

function globToRegExp(glob: string): RegExp {
  const escaped = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * preset 解析顺序：
 *   1. activePreset —— 显式指定，全局覆盖
 *   2. modelPresets —— 第一条 glob 匹配当前模型的规则
 *   3. null —— 只注入 prompt-inject.md
 */
function matchPreset(cfg: PiPurgeConfig, modelKey: string): string | null {
  if (cfg.activePreset) return cfg.activePreset;
  if (!modelKey) return null;
  for (const rule of cfg.modelPresets) {
    if (!rule || typeof rule.match !== "string" || typeof rule.preset !== "string") continue;
    if (!rule.match || !rule.preset) continue;
    try {
      if (globToRegExp(rule.match).test(modelKey)) return rule.preset;
    } catch {
      // 非法 glob，跳过这条规则
    }
  }
  return null;
}

/* -------------------------------------------------------------- 组装注入体 */

/**
 * prompt-inject.md 是主内容，命中的 preset 是模型相关的补充，两者都注入。
 * 返回纯文本，不加任何包裹标签。
 */
function buildInject(cfg: PiPurgeConfig, modelKey: string): { text: string; preset: string | null } {
  const preset = matchPreset(cfg, modelKey);
  const blocks: string[] = [];
  const inject = readText(INJECT_FILE).trim();
  const presetText = readPreset(preset).trim();
  if (inject) blocks.push(inject);
  if (presetText && presetText !== inject) blocks.push(presetText);
  return { text: blocks.join("\n\n"), preset };
}

/* ================================================================= 扩展本体 */

export default function (pi: ExtensionAPI) {
  ensureDataDir();

  /** 上一轮结束时的 stopReason，交给 agent_settled 判断要不要续跑 */
  let lastStopReason: string | undefined;
  /** 连续续跑次数；遇到正常结束就归零 */
  let continueCount = 0;

  // ---------------------------------------------------------- 提示词注入
  pi.on("before_agent_start", (event, ctx) => {
    const cfg = loadConfig();
    if (!cfg.enabled) return;

    const { text } = buildInject(cfg, modelKeyOf(ctx.model));
    if (!text) return;

    const base = event.systemPrompt ?? "";
    const systemPrompt =
      cfg.position === "prepend" ? `${text}\n\n${base}` : `${base}\n\n${text}`;
    return { systemPrompt };
  });

  // ---------------------------------------------------------- 截断检测
  pi.on("agent_end", (event) => {
    const messages = (event.messages ?? []) as Array<{ role?: string; stopReason?: string }>;
    lastStopReason = undefined;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg && msg.role === "assistant") {
        lastStopReason = msg.stopReason;
        break;
      }
    }
    // 正常收尾或正常让出工具，连续计数清零
    if (lastStopReason === "stop" || lastStopReason === "toolUse") continueCount = 0;
  });

  // ---------------------------------------------------------- 自动续跑
  // 只处理截断。报错重试交给 Pi 自带的 auto-retry，这里不重复造。
  pi.on("agent_settled", (_event, ctx) => {
    const cfg = loadConfig();
    if (!cfg.autoContinue) return;
    if (lastStopReason !== "length") return;
    if (continueCount >= cfg.continueMax) return;
    if (!ctx.isIdle()) return;

    continueCount += 1;
    try {
      pi.sendUserMessage(cfg.continueText);
    } catch {
      // 已经在跑或会话已切走，忽略
    }
  });

  /**
   * `/purge set ...` -- replace the injected text from inside Pi, without leaving
   * the session.
   *
   *   set text <文字>                 replace with inline text (short prompts)
   *   set file <路径>                 replace with a file's contents
   *   set append <文字>               append a line (keeps what is there)
   *   set clear                       empty it
   *   set restore                     restore the pre-set original
   *   set backups                     list snapshots
   *   set edit                        open the file in the OS editor
   *
   * Long prompts do not belong on a command line: `set file` and `set edit` exist
   * for those. Every write snapshots the previous content first.
   */
  async function handleSet(args: string[], ctx: any, modelKey: string): Promise<void> {
    const action = (args[0] ?? "").toLowerCase();
    const rest = args.slice(1);

    const usage = [
      "用法:",
      "  /purge set text <文字>      用这段文字替换",
      "  /purge set file <路径>      用文件内容替换",
      "  /purge set append <文字>    追加一段（保留原有）",
      "  /purge set clear            清空",
      "  /purge set restore          恢复设定前的原始内容",
      "  /purge set backups          列出备份",
      "  /purge set edit             用系统编辑器打开",
      "",
      "长提示词请用 set file 或 set edit —— 命令行长文本会被 shell 截断。",
    ].join("\n");

    const target = INJECT_FILE;

    if (action === "" || action === "help") {
      ctx.ui.notify(`当前主注入: ${readText(target).length} 字符\n\n${usage}`, "info");
      return;
    }

    if (action === "text") {
      const text = rest.join(" ");
      if (!text.trim()) {
        ctx.ui.notify(`set text 需要一个参数。\n\n${usage}`, "warning");
        return;
      }
      const bak = backupBeforeWrite(target);
      writeAtomic(target, text);
      reportWrite(ctx, text, bak);
      return;
    }

    if (action === "file") {
      const input = rest[0];
      if (!input) {
        ctx.ui.notify(`set file 需要一个路径。\n\n${usage}`, "warning");
        return;
      }
      const resolved = resolveUserPath(input, ctx.cwd ?? process.cwd());
      if (!fs.existsSync(resolved)) {
        ctx.ui.notify(`文件不存在: ${resolved}`, "error");
        return;
      }
      let text: string;
      try {
        text = fs.readFileSync(resolved, "utf8");
      } catch (err) {
        ctx.ui.notify(`读取失败: ${(err as Error).message}`, "error");
        return;
      }
      if (!text.trim()) {
        ctx.ui.notify(`文件是空的，没有写入: ${resolved}`, "warning");
        return;
      }
      const bak = backupBeforeWrite(target);
      // Strip a BOM if the source had one -- it would otherwise ride along as
      // invisible bytes at the head of the injected text.
      writeAtomic(target, text.replace(/^\uFEFF/, ""));
      reportWrite(ctx, text, bak, resolved);
      return;
    }

    if (action === "append") {
      const text = rest.join(" ");
      if (!text.trim()) {
        ctx.ui.notify(`set append 需要一个参数。\n\n${usage}`, "warning");
        return;
      }
      const current = readText(target);
      const sep = current === "" || current.endsWith("\n") ? "" : "\n";
      const next = `${current}${sep}${text}\n`;
      const bak = backupBeforeWrite(target);
      writeAtomic(target, next);
      reportWrite(ctx, next, bak);
      return;
    }

    if (action === "clear") {
      const bak = backupBeforeWrite(target);
      writeAtomic(target, "");
      ctx.ui.notify(
        bak.snap ? `已清空。原内容备份在: ${bak.snap}` : "已清空（原本就是空的）。",
        "info",
      );
      return;
    }

    if (action === "restore") {
      const orig = path.join(BACKUP_DIR, "prompt-inject.orig.md");
      if (!fs.existsSync(orig)) {
        ctx.ui.notify(`没有找到设定前的原始备份:\n${orig}`, "warning");
        return;
      }
      const text = readText(orig);
      backupBeforeWrite(target);
      writeAtomic(target, text);
      ctx.ui.notify(`已恢复 ${text.length} 字符。下一轮生效。`, "info");
      return;
    }

    if (action === "backups") {
      if (!fs.existsSync(BACKUP_DIR)) {
        ctx.ui.notify("暂无备份。", "info");
        return;
      }
      const files = fs
        .readdirSync(BACKUP_DIR)
        .filter((n) => n.startsWith("prompt-inject.") && n.endsWith(".md"))
        .sort()
        .reverse()
        .slice(0, 20);
      if (files.length === 0) {
        ctx.ui.notify("暂无备份。", "info");
        return;
      }
      const lines = files.map((n) => {
        const st = fs.statSync(path.join(BACKUP_DIR, n));
        const size = st.size.toLocaleString("en-US");
        return `${n}  ${size} 字节`;
      });
      ctx.ui.notify(`备份目录: ${BACKUP_DIR}\n\n${lines.join("\n")}`, "info");
      return;
    }

    if (action === "edit") {
      const { spawn } = await import("node:child_process");
      try {
        if (process.platform === "win32") {
          spawn("cmd", ["/c", "start", "", target], { detached: true, stdio: "ignore" }).unref();
        } else if (process.platform === "darwin") {
          spawn("open", ["-t", target], { detached: true, stdio: "ignore" }).unref();
        } else {
          spawn("xdg-open", [target], { detached: true, stdio: "ignore" }).unref();
        }
        ctx.ui.notify(
          `已打开编辑器:\n${target}\n\n保存后回来敲 /purge preview 确认，本轮结束自动重读。`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(`打开编辑器失败: ${(err as Error).message}\n直接编辑: ${target}`, "error");
      }
      return;
    }

    ctx.ui.notify(`未知的 set 动作: ${action}\n\n${usage}`, "warning");
  }

  function reportWrite(ctx: any, text: string, bak: { orig: string | null; snap: string | null }, source?: string): void {
    const lines = [
      `已写入 ${text.length} 字符${source ? `（来自 ${source}）` : ""}。`,
      bak.orig ? `原始备份: ${bak.orig}` : "",
      bak.snap ? `本次快照: ${bak.snap}` : "",
      "",
      "下一轮生效，无需重启。",
      "确认内容: /purge preview",
    ].filter(Boolean);
    ctx.ui.notify(lines.join("\n"), "info");
  }
  pi.registerCommand("purge", {
    description: "pi-purge：提示词注入、preset 与自动续跑控制",
    handler: async (args, ctx) => {
      const cfg = loadConfig();
      const argv = args.trim().split(/\s+/).filter(Boolean);
      const sub = (argv[0] ?? "status").toLowerCase();
      const modelKey = modelKeyOf(ctx.model);

      if (sub === "status") {
        const { text, preset } = buildInject(cfg, modelKey);
        const lines = [
          `状态: ${cfg.enabled ? "启用" : "停用"}   位置: ${cfg.position === "prepend" ? "系统提示词开头" : "系统提示词末尾"}`,
          `数据目录: ${DATA_DIR}`,
          `主注入 prompt-inject.md: ${readText(INJECT_FILE).trim().length} 字符`,
          `当前模型: ${modelKey || "(未选择)"}   命中 preset: ${preset ?? "无"}`,
          `本轮将注入: ${text.length} 字符`,
          `自动续跑: ${cfg.autoContinue ? `开（最多 ${cfg.continueMax} 次，文案「${cfg.continueText}」）` : "关"}`,
          `可用 preset: ${listPresets().join(", ") || "（无）"}`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (sub === "on" || sub === "apply") {
        cfg.enabled = true;
        saveConfig(cfg);
        const { text, preset } = buildInject(cfg, modelKey);
        ctx.ui.notify(
          `已启用注入（${text.length} 字符${preset ? `，preset=${preset}` : ""}）。下一轮生效，无需重启。`,
          "info",
        );
        return;
      }

      if (sub === "off" || sub === "revert") {
        cfg.enabled = false;
        saveConfig(cfg);
        ctx.ui.notify("已停用注入。prompt-inject.md 保留未动。", "info");
        return;
      }

      if (sub === "preview") {
        const { text, preset } = buildInject(cfg, modelKey);
        if (!text) {
          ctx.ui.notify(`没有可注入的内容（prompt-inject.md 为空，preset=${preset ?? "无"}）。`, "warning");
          return;
        }
        const shown = text.length > 4000 ? `${text.slice(0, 4000)}\n…（共 ${text.length} 字符）` : text;
        ctx.ui.notify(
          `将注入（preset=${preset ?? "无"}，位置=${cfg.position}）：\n\n${shown}`,
          "info",
        );
        return;
      }

      if (sub === "preset") {
        const name = argv[1];
        if (!name) {
          const list = listPresets();
          ctx.ui.notify(
            [
              `当前: ${cfg.activePreset ?? "（未指定，按模型规则匹配）"}`,
              `可用: ${list.join(", ") || "（无）"}`,
              `模型规则: ${
                cfg.modelPresets.map((r) => `${r.match} -> ${r.preset}`).join(", ") || "（无）"
              }`,
              "用法: /purge preset <文件名> 指定；/purge preset auto 取消指定",
            ].join("\n"),
            "info",
          );
          return;
        }
        if (name === "auto" || name === "clear" || name === "off") {
          cfg.activePreset = null;
          saveConfig(cfg);
          ctx.ui.notify("已取消指定 preset，改回按模型规则匹配。", "info");
          return;
        }
        if (!presetPath(name)) {
          ctx.ui.notify(`preset 必须是 ${PRESETS_DIR} 下的 .md 文件。`, "error");
          return;
        }
        if (!fs.existsSync(presetPath(name)!)) {
          ctx.ui.notify(`preset 不存在: ${name}\n可用: ${listPresets().join(", ") || "（无）"}`, "error");
          return;
        }
        cfg.activePreset = path.basename(name);
        saveConfig(cfg);
        ctx.ui.notify(`已指定 preset: ${cfg.activePreset}`, "info");
        return;
      }

      if (sub === "position") {
        const value = (argv[1] ?? "").toLowerCase();
        if (value !== "prepend" && value !== "append") {
          ctx.ui.notify(`当前: ${cfg.position}\n用法: /purge position prepend|append`, "warning");
          return;
        }
        cfg.position = value;
        saveConfig(cfg);
        ctx.ui.notify(`注入位置已设为 ${value === "prepend" ? "系统提示词开头" : "系统提示词末尾"}。`, "info");
        return;
      }

      if (sub === "continue") {
        const value = (argv[1] ?? "").toLowerCase();
        if (value === "on" || value === "off") {
          cfg.autoContinue = value === "on";
          saveConfig(cfg);
          ctx.ui.notify(`自动续跑已${cfg.autoContinue ? "开启" : "关闭"}。`, "info");
          return;
        }
        if (value === "max" && argv[2] !== undefined) {
          cfg.continueMax = clampInt(argv[2], DEFAULT_CONFIG.continueMax, 0, 20);
          saveConfig(cfg);
          ctx.ui.notify(`连续续跑上限: ${cfg.continueMax}`, "info");
          return;
        }
        if (value === "text" && argv[2]) {
          cfg.continueText = argv.slice(2).join(" ");
          saveConfig(cfg);
          ctx.ui.notify(`续跑文案: 「${cfg.continueText}」`, "info");
          return;
        }
        ctx.ui.notify(
          [
            `自动续跑: ${cfg.autoContinue ? "开" : "关"}，上限 ${cfg.continueMax} 次，文案「${cfg.continueText}」`,
            "用法: /purge continue on|off",
            "      /purge continue max <0-20>",
            "      /purge continue text <文案>",
          ].join("\n"),
          "warning",
        );
        return;
      }

      if (sub === "set") {
        await handleSet(argv.slice(1), ctx, modelKey);
        return;
      }

      ctx.ui.notify(
        [
          "/purge status            状态与本轮注入量",
          "/purge on | apply        启用注入",
          "/purge off | revert      停用注入（保留文件）",
          "/purge preview           查看将注入的内容",
          "/purge preset [名字]     查看/指定 preset（auto 取消）",
          "/purge position prepend|append",
          "/purge continue on|off|max N|text 文案",
          "/purge set               查看 set 用法",
        ].join("\n"),
        "warning",
      );
    },
  });
}
