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

const DATA_DIR = path.join(os.homedir(), ".pi", "agent", "pi-purge");
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
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
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

  // ---------------------------------------------------------- /purge 命令
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

      ctx.ui.notify(
        [
          "/purge status            状态与本轮注入量",
          "/purge on | apply        启用注入",
          "/purge off | revert      停用注入（保留文件）",
          "/purge preview           查看将注入的内容",
          "/purge preset [名字]     查看/指定 preset（auto 取消）",
          "/purge position prepend|append",
          "/purge continue on|off|max N|text 文案",
        ].join("\n"),
        "warning",
      );
    },
  });
}
