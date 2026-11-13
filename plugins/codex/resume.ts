// `exec resume` is a separate writer. When Desktop owns the thread, join that owner's official RPC instead.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commandLine } from "../../host/command.ts";
import { HOME } from "../../host/home.ts";
import { eachLine } from "../../host/lines.ts";
import type { Turn } from "../../worker/agents.ts";
import { connection } from "./connection.ts";

const { turn, argv, shared: canShare } = JSON.parse(process.argv[2]) as { turn: Turn; argv: string[]; shared: boolean };
const emit = (value: object) => console.log(JSON.stringify(value));
let stopping = Boolean(turn.cancel);
let stop = () => {};
process.on("SIGTERM", () => {
  stopping = true;
  stop();
});
process.on("SIGINT", () => {
  stopping = true;
  stop();
});
emit({ type: "autoloop.resume", thread_id: turn.resume });
if (turn.cancel) emit({ type: "autoloop.external", active: true });

type Receipt = {
  clientId: string;
  threadId: string;
  submitted?: boolean;
  turnId?: string;
  status?: string;
  text?: string;
  usage?: object;
};
const key = createHash("sha256")
  .update(JSON.stringify([turn.resume, turn.requestId ?? [turn.folder, turn.prompt, argv[0]]]))
  .digest("hex");
const directory = join(HOME, "worker", "codex");
const file = join(directory, `${key}.json`);
let receipt: Receipt | undefined;
try {
  receipt = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
if (receipt !== undefined && (!receipt || receipt.threadId !== turn.resume || typeof receipt.clientId !== "string"))
  throw new Error("Codex 续接记录不完整或会话不一致，拒绝重复提交");
const save = (patch: Partial<Receipt>) => {
  receipt = { clientId: receipt?.clientId ?? randomUUID(), threadId: turn.resume!, ...receipt, ...patch };
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(receipt));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
  const parent = openSync(directory, "r");
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
};
const external = (active: boolean) => emit({ type: "autoloop.external", active });
const deliver = () => {
  emit({ type: "thread.started", thread_id: turn.resume });
  emit({ type: "item.completed", item: { type: "agent_message", text: receipt?.text ?? "" } });
  external(false);
  emit({ type: "turn.completed", ...(receipt?.usage && { usage: receipt.usage }) });
};
if (receipt?.submitted && !receipt.status) external(true);

async function shared() {
  const relay = await connection(argv[0]);
  const ws = new WebSocket(relay.url);
  let next = 0;
  const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
  let own = receipt?.turnId ?? "";
  let collecting = Boolean(receipt?.submitted);
  const buffered: any[] = [];
  let usage: object | undefined = receipt?.usage;
  let text = receipt?.text ?? "";
  let liveMessage = false;
  let threadStatus: string | undefined;
  let idle: (() => void) | undefined;
  let idleFailed: ((error: Error) => void) | undefined;
  let complete!: (value: any) => void;
  let broken!: (error: Error) => void;
  const completed = new Promise<any>((resolve, reject) => {
    complete = resolve;
    broken = reject;
  });
  // A connection can fail while a control request is still in flight.
  void completed.catch(() => {});
  const fail = () => {
    const error = new Error(relay.error() || "Codex 原会话连接中断；保留原会话，不重开。");
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    idleFailed?.(error);
    broken(error);
  };
  ws.addEventListener("close", fail);
  ws.addEventListener("error", fail);
  const rpc = (method: string, params: object) =>
    new Promise<any>((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const notification = (message: any) => {
    const p = message.params;
    if (p?.threadId !== turn.resume || (p.turnId ?? p.turn?.id) !== own) return;
    if (message.method === "item/completed" && p.item?.type === "agentMessage") {
      liveMessage = true;
      text = p.item.text;
      emit({ type: "item.completed", item: { type: "agent_message", text: p.item.text } });
    }
    if (message.method === "thread/tokenUsage/updated" && p.tokenUsage?.total) {
      const u = p.tokenUsage.total;
      usage = { input_tokens: u.inputTokens, output_tokens: u.outputTokens, cached_input_tokens: u.cachedInputTokens };
    }
    if (message.method === "turn/completed") complete(p.turn);
  };
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "thread/status/changed" && message.params?.threadId === turn.resume) {
      threadStatus = message.params.status.type;
      if (threadStatus === "idle") idle?.();
    }
    if (message.method && message.id !== undefined) {
      ws.send(
        JSON.stringify({ id: message.id, error: { code: -32601, message: "后台任务不接受交互请求，请用回执提问。" } }),
      );
    } else if (pending.has(message.id)) {
      const request = pending.get(message.id)!;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    } else if (collecting && message.params?.threadId === turn.resume) {
      if (own) notification(message);
      else buffered.push(message);
    }
  });
  let interrupted = false;
  const interrupt = () => {
    if (own && !interrupted) {
      interrupted = true;
      void rpc("turn/interrupt", { threadId: turn.resume, turnId: own }).catch(fail);
    }
  };
  stop = () => {
    if (own) interrupt();
    else idleFailed?.(new Error("本轮已停止"));
  };
  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error(relay.error() || "无法连接 Codex 共享服务")), { once: true });
    });
    await rpc("initialize", {
      clientInfo: { name: "agent_autoloop", version: "1" },
      capabilities: { experimentalApi: true },
    });
    ws.send(JSON.stringify({ method: "initialized", params: {} }));
    const resumed = await rpc("thread/resume", { threadId: turn.resume, excludeTurns: true });
    if (resumed.thread.id !== turn.resume) throw new Error("Codex 返回了不同的会话，拒绝继续。");
    let recovered: any;
    if (receipt?.submitted) {
      let cursor: string | undefined;
      do {
        const page = await rpc("thread/turns/list", {
          threadId: turn.resume,
          limit: 20,
          itemsView: "full",
          ...(cursor && { cursor }),
        });
        recovered = page.data.find(
          (item: any) =>
            item.id === receipt?.turnId ||
            item.items?.some((entry: any) => entry.type === "userMessage" && entry.clientId === receipt?.clientId),
        );
        cursor = page.nextCursor;
      } while (!recovered && cursor);
      if (!recovered) throw new Error("无法确认上次提交的结果；保留原会话与记录，不重复提交。");
      own = recovered.id;
      if (!liveMessage)
        text = recovered.items?.filter((item: any) => item.type === "agentMessage").at(-1)?.text ?? text;
      save({ turnId: own, text });
      if (text) emit({ type: "item.completed", item: { type: "agent_message", text } });
      if (recovered.status !== "inProgress") {
        save({ status: recovered.status, text, usage });
        external(false);
        if (recovered.status !== "completed")
          throw new Error(recovered.error?.message || `Codex 本轮没有完成：${recovered.status}`);
        deliver();
        return;
      }
    }
    const status = threadStatus ?? resumed.thread.status.type;
    if (!own && status === "active") {
      console.error("Codex 原会话正在执行，已保留本次回答；空闲后自动继续，不重开会话。");
      await new Promise<void>((resolve, reject) => {
        idle = resolve;
        idleFailed = reject;
      });
    } else if (!own && status !== "idle") throw new Error(`Codex 原会话无法继续：${status}`);
    if (stopping && !own) throw new Error("本轮已停止");
    emit({ type: "thread.started", thread_id: turn.resume });
    collecting = true;
    const sandboxPolicy =
      turn.access === "full"
        ? { type: "dangerFullAccess" }
        : turn.access === "edit"
          ? { type: "workspaceWrite", writableRoots: [turn.cwd], networkAccess: false }
          : { type: "readOnly", networkAccess: false };
    if (!own) {
      save({ submitted: true });
      external(true);
      const started = await rpc("turn/start", {
        threadId: turn.resume,
        clientUserMessageId: receipt!.clientId,
        input: [{ type: "text", text: argv.at(-1)! }],
        cwd: turn.cwd,
        approvalPolicy: "never",
        sandboxPolicy,
        ...(turn.model && { model: turn.model }),
        ...(turn.effort && { effort: turn.effort }),
        ...(turn.tier && { serviceTier: turn.tier }),
      });
      own = started.turn.id;
      save({ turnId: own });
    }
    emit({ type: "turn.started" });
    for (const message of buffered) notification(message);
    if (stopping) interrupt();
    const result = await completed;
    save({ status: result.status, text, usage });
    external(false);
    if (result.status !== "completed") throw new Error(result.error?.message || `Codex 本轮没有完成：${result.status}`);
    emit({ type: "turn.completed", ...(usage && { usage }) });
    // The business result is final. Losing the cleanup response must not turn it into a retry.
    await rpc("thread/unsubscribe", { threadId: turn.resume }).catch(() => {});
  } finally {
    stop = () => {};
    ws.removeEventListener("close", fail);
    ws.removeEventListener("error", fail);
    ws.close();
    await relay.close();
  }
}

async function run() {
  if (receipt?.status === "completed") return deliver();
  if (turn.cancel && receipt?.status) {
    external(false);
    throw new Error(`原轮次已结束：${receipt.status}`);
  }
  if (receipt?.submitted && !canShare) throw new Error("此启动方式不能接入共享服务；保留原会话与提交记录。");
  // A known failed turn may be continued; an unknown or completed turn must first be read back.
  if (receipt?.status) receipt = undefined;
  const carry = async () => {
    try {
      return await shared();
    } catch (error) {
      if (!receipt?.submitted || receipt.status) throw error;
      console.error("Codex 连接中断，先读回原轮次结果，不再次提交业务。");
      return shared();
    }
  };
  if (turn.cancel && !receipt?.submitted) throw new Error("缺少原外部轮次记录，不能确认停止，也不会重发业务。");
  if (receipt?.submitted) return carry();
  const [program, args] = commandLine(argv);
  const child = spawn(program, args, { cwd: turn.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let started = false;
  let error = "";
  stop = () => child.kill("SIGTERM");
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  eachLine(child.stdout, (line) => {
    try {
      if (JSON.parse(line).type === "turn.started") started = true;
    } catch {}
  });
  child.stderr.on("data", (chunk) => (error = (error + chunk).slice(-4000)));
  const [code] = await once(child, "close");
  if (code === 0) return;
  if (canShare && !stopping && !started && /thread.*already has an active writer/.test(error)) {
    console.error("Codex 原会话由共享服务持有，改由原服务接回同一会话。");
    return carry();
  }
  throw new Error(error || "Codex 没有完成原会话的这一轮");
}

run().catch((error) => {
  emit({ type: "error", message: error.message });
  console.error(error.message);
  process.exitCode = 1;
});
