// Exercises the /purge set command group against a scratch agent dir.
// Runs the real extension, not a copy of its logic.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "purge-set-"));
const agentDir = path.join(base, "agent");
const dataDir = path.join(agentDir, "pi-purge");
fs.mkdirSync(path.join(dataDir, "presets"), { recursive: true });
fs.mkdirSync(path.join(base, "cwd"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const target = path.join(dataDir, "prompt-inject.md");
const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "  <- " + detail}`);
}

// Boot the extension the way Pi does and capture what it says.
const mod = await import("./index.ts");
const commands = new Map();
const notices = [];
let hook = null;

const pi = {
  registerCommand: (name, def) => commands.set(name, def),
  on: (event, handler) => { if (event === "before_agent_start") hook = handler; },
  registerTool: () => {},
  registerProvider: () => {},
  unregisterProvider: () => {},
};
mod.default(pi);

const purge = commands.get("purge");
if (!purge) {
  console.error("purge command was never registered");
  process.exit(1);
}

const ctx = {
  cwd: path.join(base, "cwd"),
  model: { provider: "test", id: "m" },
  ui: {
    notify: (msg, level) => notices.push({ msg, level }),
  },
};
const run = async (args) => {
  notices.length = 0;
  await purge.handler(args, ctx);
  return notices.map((n) => n.msg).join("\n");
};

// ── 1. set text ────────────────────────────────────────────────────────────
fs.writeFileSync(target, "OLD CONTENT", "utf8");
let out = await run("set text 新的人格设定");
check("set text writes the new content", fs.readFileSync(target, "utf8") === "新的人格设定", fs.readFileSync(target, "utf8"));
check("set text reports success", /已写入/.test(out), out);
check("set text keeps an original backup",
  fs.existsSync(path.join(dataDir, "backup", "prompt-inject.orig.md")),
  "no orig backup");
check("backup holds the pre-edit content",
  fs.readFileSync(path.join(dataDir, "backup", "prompt-inject.orig.md"), "utf8") === "OLD CONTENT");

// ── 2. set file (with a BOM, which must be stripped) ───────────────────────
const srcFile = path.join(base, "my-prompt.txt");
fs.writeFileSync(srcFile, "\uFEFF从文件来的提示词", "utf8");
out = await run(`set file ${srcFile}`);
const fromFile = fs.readFileSync(target, "utf8");
check("set file copies the content", fromFile === "从文件来的提示词", JSON.stringify(fromFile));
check("set file strips the BOM", !fromFile.startsWith("\uFEFF"));
check("set file names the source", out.includes("my-prompt.txt"), out);

// ── 3. set file with a missing path ────────────────────────────────────────
out = await run(`set file ${path.join(base, "nope.txt")}`);
check("missing file is refused", /不存在/.test(out), out);
check("missing file leaves content untouched",
  fs.readFileSync(target, "utf8") === "从文件来的提示词");

// ── 4. set append ──────────────────────────────────────────────────────────
await run("set append 追加的一行");
const appended = fs.readFileSync(target, "utf8");
check("set append keeps the old text", appended.includes("从文件来的提示词"), appended);
check("set append adds the new line", appended.includes("追加的一行"), appended);

// ── 5. set clear ───────────────────────────────────────────────────────────
await run("set clear");
check("set clear empties the file", fs.readFileSync(target, "utf8") === "");

// ── 6. set restore ─────────────────────────────────────────────────────────
await run("set restore");
check("set restore brings back the original",
  fs.readFileSync(target, "utf8") === "OLD CONTENT",
  fs.readFileSync(target, "utf8"));

// ── 6b. undo: step back one edit ───────────────────────────────────────────
// Each write snapshots what preceded it, so: set V1 leaves a snapshot of the
// current file, set V2 leaves one of V1, set V3 leaves one of V2. Undo must land
// on V2 -- the state immediately before the last write.
fs.writeFileSync(target, "V1", "utf8");
await run("set text V1");   // snapshot: "V1" (from the write above)
await run("set text V2");   // snapshot: "V1"
await run("set text V3");   // snapshot: "V2"
check("content is V3 before undo", fs.readFileSync(target, "utf8") === "V3");
await run("set undo");
check("undo steps back to V2", fs.readFileSync(target, "utf8") === "V2", fs.readFileSync(target, "utf8"));
await run("set undo");
check("undo again steps back to V1", fs.readFileSync(target, "utf8") === "V1", fs.readFileSync(target, "utf8"));

// ── 6c. undo consumes the stack rather than bouncing ───────────────────────
// Undo pops a snapshot, so repeated undo walks backwards through history instead
// of alternating between two states.
const undoStack = () => {
  const bd = path.join(dataDir, "backup");
  if (!fs.existsSync(bd)) return 0;
  return fs.readdirSync(bd).filter(
    (n) => /^prompt-inject\.\d{4}-.*\.md$/.test(n) && !n.includes(".undone-") && n !== "prompt-inject.orig.md",
  ).length;
};

fs.writeFileSync(target, "STACK-BASE", "utf8");
await run("set text S1");
await run("set text S2");
await run("set text S3");
const depthBefore = undoStack();
check("each edit adds a snapshot", depthBefore >= 3, `depth=${depthBefore}`);

await run("set undo");
const u1 = fs.readFileSync(target, "utf8");
await run("set undo");
const u2 = fs.readFileSync(target, "utf8");

check("undo walks backwards", u1 !== u2, `u1=${JSON.stringify(u1)} u2=${JSON.stringify(u2)}`);
check("undo never resurrects the newest state", u1 !== "S3" && u2 !== "S3", `${u1}/${u2}`);
check("undo consumes the stack", undoStack() < depthBefore, `before=${depthBefore} after=${undoStack()}`);

// The state an undo walks away from is preserved, not destroyed.
const backupFiles = fs.readdirSync(path.join(dataDir, "backup"));
check("the state an undo leaves behind is kept on disk",
  backupFiles.some((n) => n.includes(".undone-")),
  backupFiles.join(", "));

// ── 6d. rollback with no argument lists snapshots ──────────────────────────
out = await run("set rollback");
check("bare rollback lists snapshots", /可用快照/.test(out), out);

// ── 6e. rollback by index ──────────────────────────────────────────────────
fs.writeFileSync(target, "INDEX-TARGET", "utf8");
await run("set text SNAP-A");
await run("set text SNAP-B");
const listing = await run("set backups");
const idxOfA = listing
  .split("\n")
  .find((l) => l.includes("SNAP") || /^\d+\./.test(l.trim()) && l.includes(".md"));
// Roll back to the oldest snapshot index via the printed list.
out = await run("set rollback 1");
check("rollback by index reports the snapshot", /已回滚到/.test(out), out);

// ── 6f. rollback by name fragment ──────────────────────────────────────────
const snapsOut = await run("set backups");
const firstName = (snapsOut.match(/\d+\.\s+(\S+\.md)/) ?? [])[1];
if (firstName) {
  out = await run(`set rollback ${firstName.replace(".md", "")}`);
  check("rollback by name fragment works", /已回滚到/.test(out), out);
} else {
  check("rollback by name fragment works (skipped: no name parsed)", false, snapsOut.slice(0, 200));
}

// ── 6g. rollback to a nonexistent snapshot is refused ──────────────────────
out = await run("set rollback does-not-exist-xyz");
check("unknown snapshot is refused", /没有找到快照/.test(out), out);

// ── 7. set backups ─────────────────────────────────────────────────────────
out = await run("set backups");
check("set backups lists snapshots", out.includes("prompt-inject."), out);

// ── 8. set with no args shows usage ────────────────────────────────────────
out = await run("set");
check("bare set shows usage", out.includes("用法"), out);

// ── 9. unknown action is reported, not silently ignored ────────────────────
out = await run("set nonsense");
check("unknown action warns", /未知的 set 动作/.test(out), out);

// ── 10. injected text actually reaches the system prompt ───────────────────
fs.writeFileSync(target, "INJECTED MARKER", "utf8");
const built = await hook({ systemPrompt: "BASE PROMPT" }, ctx);
const sp = built?.systemPrompt ?? "";
check("injection lands in the system prompt", sp.includes("INJECTED MARKER"), sp.slice(0, 120));
check("Pi's own prompt is preserved", sp.includes("BASE PROMPT"), sp.slice(0, 120));

// ── 11. no BOM on any write ────────────────────────────────────────────────
const raw = fs.readFileSync(target);
check("file has no BOM", !(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
fs.rmSync(base, { recursive: true, force: true });
process.exit(failed.length === 0 ? 0 : 1);
