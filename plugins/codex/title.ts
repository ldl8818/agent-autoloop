// Naming is metadata only: never resume a thread or resubmit business work to give it a title.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commandLine } from "../../host/command.ts";
import { eachLine } from "../../host/lines.ts";
import { findProgram } from "../../worker/agents.ts";
import { IN_THE_APP } from "./agent.ts";
import { connection } from "./connection.ts";

type Rpc = (method: string, params: object) => Promise<any>;

function chineseTitle(value: string) {
  const body = value
    .trim()
    .replace(/^(?:autoloop-)+/i, "")
    .replace(/ *[|｜] */g, "｜");
  const parts = body.split("｜");
  if (parts.length !== 2 || parts.some((part) => !/\p{Script=Han}/u.test(part)) || /[\r\n\t]/.test(body)) return null;
  return `autoloop-${body}`;
}

export async function renameThread(rpc: Rpc, threadId: string, fallback: string) {
  const read = await rpc("thread/read", { threadId, includeTurns: false });
  if (read.thread.id !== threadId) throw new Error("标题所属会话不一致");
  const name = chineseTitle(String(read.thread.name || "")) ?? chineseTitle(fallback);
  // Rule names and worktree IDs identify execution, not the business module or its goal.
  if (!name) return false;
  if (read.thread.name === name) return true;
  await rpc("thread/name/set", { threadId, name });
  const verified = await rpc("thread/read", { threadId, includeTurns: false });
  if (verified.thread.id !== threadId || verified.thread.name !== name) throw new Error("原生标题读回不一致");
  return true;
}

export function namingPrompt() {
  return (
    "\n\n本会话由 Autoloop 发起。首个实质结果交付前，按 ~/.agents/docs/Codex会话分区.md 的现有命名规则，" +
    "根据本任务内容确定中文模块名和持续目标，保留 autoloop- 前缀。不得使用规则 ID、工作区名、卡片编号或临时进度代替模块与目标。" +
    "在本轮最终答复和原有 agent-autoloop 回执之后，单独附上以下标题块，将内容换为确定的模块和目标。" +
    "宿主会剥离此块、校验格式并通过现有原生连接命名，不需要你在沙箱内连接桌面服务，也不为改名另跑业务。\n" +
    "```autoloop-title\n中文模块名｜持续目标\n```"
  );
}

export function titleResult(text: string) {
  const match = /(?:^|\r?\n)```autoloop-title[ \t]*\r?\n([^\r\n]*)\r?\n```\s*$/.exec(text);
  return match ? { text: text.slice(0, match.index).trimEnd(), title: chineseTitle(match[1]) } : { text, title: null };
}

export async function nameSession(program: string, threadId: string, title: string) {
  const relay = await connection(program);
  const ws = new WebSocket(relay.url);
  let next = 0;
  let pending: { id: number; resolve: (value: any) => void; reject: (error: Error) => void } | undefined;
  let failed: Error | undefined;
  const fail = (error: Error) => {
    failed = error;
    pending?.reject(error);
    ws.close();
  };
  const timer = setTimeout(() => fail(new Error("标题接口连接超时")), 5000);
  ws.addEventListener("close", () => fail(new Error(relay.error() || "标题接口连接关闭")), { once: true });
  ws.addEventListener("error", () => fail(new Error(relay.error() || "标题接口连接失败")), { once: true });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== pending?.id) return;
    if (message.error) pending!.reject(new Error(message.error.message));
    else pending!.resolve(message.result);
  });
  const rpc: Rpc = (method, params) =>
    new Promise((resolve, reject) => {
      if (failed) return reject(failed);
      const id = ++next;
      pending = { id, resolve, reject };
      ws.send(JSON.stringify({ id, method, params }));
    });
  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("close", () => reject(failed || new Error("标题接口连接关闭")), { once: true });
      ws.addEventListener("error", () => reject(failed || new Error("标题接口连接失败")), { once: true });
    });
    await rpc("initialize", { clientInfo: { name: "autoloop_title", version: "1" } });
    ws.send(JSON.stringify({ method: "initialized", params: {} }));
    await renameThread(rpc, threadId, title);
  } finally {
    clearTimeout(timer);
    ws.close();
    await relay.close();
  }
}

async function run() {
  const { argv, program, cwd, title } = JSON.parse(process.argv[2]) as {
    argv: string[];
    program?: string;
    cwd: string;
    title: string;
  };
  const [executable, args] = commandLine(argv);
  const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  let stopping = false;
  const stop = () => {
    stopping = true;
    child.kill("SIGTERM");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  let threadId: string | undefined;
  child.stdout!.on("data", (chunk) => process.stdout.write(chunk));
  eachLine(child.stdout!, (line) => {
    try {
      const event = JSON.parse(line);
      if (event.type === "thread.started" || event.type === "autoloop.resume") threadId = event.thread_id;
    } catch {}
  });
  const [code] = await once(child, "close");
  process.exitCode = code ?? 1;
  if (threadId && !stopping) {
    try {
      await nameSession(program ?? findProgram("codex", () => IN_THE_APP), threadId, title);
    } catch (error) {
      console.error(`Codex 标题未同步：${(error as Error).message}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
