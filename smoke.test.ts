// pi-purge 冒烟测试：不连真实模型，用 mock 的 ExtensionAPI 驱动扩展
// 运行：node --experimental-strip-types smoke.test.ts
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 扩展内部把数据目录写死在 ~/.pi/agent/pi-purge。测试前把 HOME 指向临时目录，
// 这样不会污染真实配置。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-purge-test-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const { default: makePurge } = await import("./index.ts");

type Handler = (event: any, ctx: any) => any;

function makeHarness() {
  const events = new Map<string, Handler>();
  const commands = new Map<string, any>();
  const sent: string[] = [];
  const notices: Array<{ msg: string; type?: string }> = [];

  const pi = {
    on(name: string, h: Handler) {
      events.set(name, h);
    },
    registerCommand(name: string, opts: any) {
      commands.set(name, opts);
    },
    sendUserMessage(text: string) {
      sent.push(text);
    },
  };

  makePurge(pi as any);

  const ctx = (model?: { provider: string; id: string }, idle = true) => ({
    model,
    isIdle: () => idle,
    ui: {
      notify: (msg: string, type?: string) => notices.push({ msg, type }),
    },
  });

  return { events, commands, sent, notices, ctx };
}

function dataDir() {
  return path.join(tmpHome, ".pi", "agent", "pi-purge");
}
function writeInject(text: string) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(path.join(dataDir(), "prompt-inject.md"), text, "utf8");
}
function writeConfig(obj: any) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(path.join(dataDir(), "config.json"), JSON.stringify(obj, null, 2), "utf8");
}
function readConfig() {
  return JSON.parse(fs.readFileSync(path.join(dataDir(), "config.json"), "utf8"));
}
function writePreset(name: string, text: string) {
  const dir = path.join(dataDir(), "presets");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), text, "utf8");
}

let passed = 0;
// 测试按顺序排队执行，异步用例 await 完再跑下一个——否则 async 断言失败会
// 逃出框架、变成 uncaught rejection，同步部分却照样打印 ok（假绿）。
let chain: Promise<void> = Promise.resolve();

function group(title: string) {
  chain = chain.then(() => {
    console.log(title);
  });
}

function ok(name: string, fn: () => Promise<void> | void) {
  chain = chain.then(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  ok   ${name}`);
    } catch (err: any) {
      console.error(`  FAIL ${name}\n       ${err?.message}`);
      process.exitCode = 1;
    }
  });
}

/* ---------------------------------------------------------------- 注入 */

group("注入逻辑");

ok("空 prompt-inject.md 时不改系统提示词", () => {
  const h = makeHarness();
  writeInject("   \n  ");
  const r = h.events.get("before_agent_start")!(
    { systemPrompt: "BASE" },
    h.ctx({ provider: "deepseek", id: "deepseek-chat" }),
  );
  assert.equal(r, undefined);
});

ok("有内容时追加到系统提示词末尾", () => {
  const h = makeHarness();
  writeInject("MY_PROMPT_BODY");
  const r = h.events.get("before_agent_start")!(
    { systemPrompt: "BASE" },
    h.ctx({ provider: "deepseek", id: "deepseek-chat" }),
  );
  assert.equal(r.systemPrompt, "BASE\n\nMY_PROMPT_BODY");
});

ok("position=prepend 时放到最前", () => {
  const h = makeHarness();
  writeConfig({ position: "prepend" });
  writeInject("MY_PROMPT_BODY");
  const r = h.events.get("before_agent_start")!(
    { systemPrompt: "BASE" },
    h.ctx({ provider: "deepseek", id: "deepseek-chat" }),
  );
  assert.equal(r.systemPrompt, "MY_PROMPT_BODY\n\nBASE");
});

ok("enabled=false 时不注入", () => {
  const h = makeHarness();
  writeConfig({ enabled: false });
  writeInject("MY_PROMPT_BODY");
  const r = h.events.get("before_agent_start")!(
    { systemPrompt: "BASE" },
    h.ctx({ provider: "deepseek", id: "deepseek-chat" }),
  );
  assert.equal(r, undefined);
});

ok("模型规则命中时补充 preset", () => {
  const h = makeHarness();
  writeConfig({ modelPresets: [{ match: "deepseek/*", preset: "ds.md" }] });
  writeInject("MAIN");
  writePreset("ds.md", "PRESET_FOR_DEEPSEEK");
  const r = h.events.get("before_agent_start")!(
    { systemPrompt: "BASE" },
    h.ctx({ provider: "deepseek", id: "deepseek-chat" }),
  );
  assert.equal(r.systemPrompt, "BASE\n\nMAIN\n\nPRESET_FOR_DEEPSEEK");
});

ok("模型规则不命中时不带 preset", () => {
  const h = makeHarness();
  writeConfig({ modelPresets: [{ match: "deepseek/*", preset: "ds.md" }] });
  writeInject("MAIN");
  writePreset("ds.md", "PRESET_FOR_DEEPSEEK");
  const r = h.events.get("before_agent_start")!(
    { systemPrompt: "BASE" },
    h.ctx({ provider: "anthropic", id: "claude-sonnet-4" }),
  );
  assert.equal(r.systemPrompt, "BASE\n\nMAIN");
});

ok("activePreset 指定后无视模型规则", () => {
  const h = makeHarness();
  writeConfig({
    activePreset: "pinned.md",
    modelPresets: [{ match: "*claude*", preset: "claude.md" }],
  });
  writeInject("MAIN");
  writePreset("pinned.md", "PINNED");
  writePreset("claude.md", "CLAUDE");
  const r = h.events.get("before_agent_start")!(
    { systemPrompt: "BASE" },
    h.ctx({ provider: "anthropic", id: "claude-sonnet-4" }),
  );
  assert.equal(r.systemPrompt, "BASE\n\nMAIN\n\nPINNED");
});

ok("preset 路径穿越被挡下", () => {
  const h = makeHarness();
  writeConfig({ activePreset: "../../evil.md" });
  writeInject("MAIN");
  const r = h.events.get("before_agent_start")!(
    { systemPrompt: "BASE" },
    h.ctx({ provider: "x", id: "y" }),
  );
  assert.equal(r.systemPrompt, "BASE\n\nMAIN");
});

/* ------------------------------------------------------------ 自动续跑 */

group("自动续跑");

ok("截断且空闲时自动发「继续」", () => {
  const h = makeHarness();
  writeConfig({ autoContinue: true, continueMax: 3 });
  h.events.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "length" }] }, h.ctx());
  h.events.get("agent_settled")!({}, h.ctx());
  assert.deepEqual(h.sent, ["继续"]);
});

ok("正常结束不续跑", () => {
  const h = makeHarness();
  writeConfig({ autoContinue: true });
  h.events.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "stop" }] }, h.ctx());
  h.events.get("agent_settled")!({}, h.ctx());
  assert.deepEqual(h.sent, []);
});

ok("用户中断不续跑", () => {
  const h = makeHarness();
  writeConfig({ autoContinue: true });
  h.events.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "aborted" }] }, h.ctx());
  h.events.get("agent_settled")!({}, h.ctx());
  assert.deepEqual(h.sent, []);
});

ok("busy 时不续跑", () => {
  const h = makeHarness();
  writeConfig({ autoContinue: true });
  h.events.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "length" }] }, h.ctx());
  h.events.get("agent_settled")!({}, h.ctx(undefined, false));
  assert.deepEqual(h.sent, []);
});

ok("超过上限后停止", () => {
  const h = makeHarness();
  writeConfig({ autoContinue: true, continueMax: 2 });
  const end = h.events.get("agent_end")!;
  const settled = h.events.get("agent_settled")!;
  end({ messages: [{ role: "assistant", stopReason: "length" }] }, h.ctx());
  settled({}, h.ctx());
  end({ messages: [{ role: "assistant", stopReason: "length" }] }, h.ctx());
  settled({}, h.ctx());
  end({ messages: [{ role: "assistant", stopReason: "length" }] }, h.ctx());
  settled({}, h.ctx());
  assert.deepEqual(h.sent, ["继续", "继续"]);
});

ok("遇到正常结束会重置计数", () => {
  const h = makeHarness();
  writeConfig({ autoContinue: true, continueMax: 1 });
  const end = h.events.get("agent_end")!;
  const settled = h.events.get("agent_settled")!;
  end({ messages: [{ role: "assistant", stopReason: "length" }] }, h.ctx());
  settled({}, h.ctx());
  assert.equal(h.sent.length, 1, "第一次应该续跑");
  // 正常结束 -> 计数清零
  end({ messages: [{ role: "assistant", stopReason: "stop" }] }, h.ctx());
  end({ messages: [{ role: "assistant", stopReason: "length" }] }, h.ctx());
  settled({}, h.ctx());
  assert.equal(h.sent.length, 2, "计数应已重置，可再次续跑");
});

ok("autoContinue=false 时不续跑", () => {
  const h = makeHarness();
  writeConfig({ autoContinue: false });
  h.events.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "length" }] }, h.ctx());
  h.events.get("agent_settled")!({}, h.ctx());
  assert.deepEqual(h.sent, []);
});

ok("自定义续跑文案生效", () => {
  const h = makeHarness();
  writeConfig({ autoContinue: true, continueText: "接着写" });
  h.events.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "length" }] }, h.ctx());
  h.events.get("agent_settled")!({}, h.ctx());
  assert.deepEqual(h.sent, ["接着写"]);
});

/* -------------------------------------------------------------- 命令 */

group("/purge 命令");

ok("命令已注册", () => {
  const h = makeHarness();
  assert.ok(h.commands.has("purge"), "应注册 /purge");
});

async function runCommand(h: ReturnType<typeof makeHarness>, args: string) {
  h.notices.length = 0;
  await h.commands.get("purge").handler(args, h.ctx({ provider: "deepseek", id: "deepseek-chat" }));
  return h.notices.map((n) => n.msg).join("\n");
}

ok("status 报告启用状态与注入量", async () => {
  const h = makeHarness();
  writeInject("HELLO_PROMPT");
  const out = await runCommand(h, "status");
  assert.match(out, /启用/);
  assert.match(out, /HELLO_PROMPT/.test(out) ? /将注入: 12 字符/ : /将注入/);
});

ok("off 停用注入且保留文件", async () => {
  const h = makeHarness();
  writeInject("HELLO_PROMPT");
  await runCommand(h, "off");
  assert.equal(readConfig().enabled, false);
  assert.equal(fs.readFileSync(path.join(dataDir(), "prompt-inject.md"), "utf8"), "HELLO_PROMPT");
  const r = h.events.get("before_agent_start")!(
    { systemPrompt: "BASE" },
    h.ctx({ provider: "deepseek", id: "deepseek-chat" }),
  );
  assert.equal(r, undefined, "停用后不应注入");
});

ok("on 重新启用", async () => {
  const h = makeHarness();
  writeInject("HELLO_PROMPT");
  await runCommand(h, "off");
  await runCommand(h, "on");
  assert.equal(readConfig().enabled, true);
  const r = h.events.get("before_agent_start")!(
    { systemPrompt: "BASE" },
    h.ctx({ provider: "deepseek", id: "deepseek-chat" }),
  );
  assert.equal(r.systemPrompt, "BASE\n\nHELLO_PROMPT");
});

ok("preset 切换与取消", async () => {
  const h = makeHarness();
  writeInject("MAIN");
  writePreset("a.md", "PRESET_A");
  await runCommand(h, "preset a.md");
  assert.equal(readConfig().activePreset, "a.md");
  const r1 = h.events.get("before_agent_start")!(
    { systemPrompt: "BASE" },
    h.ctx({ provider: "x", id: "y" }),
  );
  assert.match(r1.systemPrompt, /PRESET_A/);
  await runCommand(h, "preset auto");
  assert.equal(readConfig().activePreset, null);
});

ok("preset 拒绝非本目录文件", async () => {
  const h = makeHarness();
  writeInject("MAIN");
  await runCommand(h, "preset ../../secret.md");
  assert.notEqual(readConfig().activePreset, "../../secret.md");
  const out = await runCommand(h, "preset ../../secret.md");
  assert.match(out, /\.md/);
});

ok("position 切换", async () => {
  const h = makeHarness();
  writeInject("BODY");
  await runCommand(h, "position prepend");
  assert.equal(readConfig().position, "prepend");
  const r = h.events.get("before_agent_start")!(
    { systemPrompt: "BASE" },
    h.ctx({ provider: "x", id: "y" }),
  );
  assert.equal(r.systemPrompt, "BODY\n\nBASE");
});

ok("continue max 限制范围", async () => {
  const h = makeHarness();
  await runCommand(h, "continue max 99");
  assert.equal(readConfig().continueMax, 20);
  await runCommand(h, "continue max -5");
  assert.equal(readConfig().continueMax, 0);
});

ok("continue off 关闭续跑", async () => {
  const h = makeHarness();
  writeConfig({ autoContinue: true });
  await runCommand(h, "continue off");
  assert.equal(readConfig().autoContinue, false);
});

ok("未知子命令给出用法", async () => {
  const h = makeHarness();
  const out = await runCommand(h, "bogus");
  assert.match(out, /\/purge status/);
});

await chain;
console.log(`\n${passed} passed${process.exitCode ? "（有失败）" : ""}`);
