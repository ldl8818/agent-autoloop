// All business turns use the official shared daemon; receipts survive worker retries and lost RPC responses.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "../../host/home.ts";
import type { Turn } from "../../worker/agents.ts";
import { readMessage } from "../../worker/contract.ts";
import { connection } from "./connection.ts";
import { renameThread } from "./title.ts";
import { resultText } from "./agent.ts";

const { turn, program } = JSON.parse(process.argv[2]) as { turn: Turn; program: string };
const sandbox = { read: "read-only", edit: "workspace-write", full: "danger-full-access" }[turn.access];
let threadId = turn.resume ?? "";
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
if (threadId) emit({ type: "autoloop.resume", thread_id: threadId });
if (turn.cancel) emit({ type: "autoloop.external", active: true });

type Receipt = {
  clientId: string;
  threadId: string;
  creating?: boolean;
  submitted?: boolean;
  turnId?: string;
  status?: string;
  text?: string;
  usage?: object;
  attempt?: number;
  continuation?: number;
  inputs?: string[];
};
const key = createHash("sha256")
  .update(JSON.stringify(turn.requestId ?? [turn.session, turn.folder, turn.prompt, program]))
  .digest("hex");
const directory = join(HOME, "worker", "codex");
const file = join(directory, `${key}.json`);
let receipt: Receipt | undefined;
try {
  receipt = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  // Preserve stop/recovery receipts written by the previous exec-resume bridge during an upgrade.
  if (turn.resume && turn.requestId) {
    const legacy = createHash("sha256")
      .update(JSON.stringify([turn.resume, turn.requestId]))
      .digest("hex");
    try {
      receipt = JSON.parse(readFileSync(join(directory, `${legacy}.json`), "utf8"));
    } catch (legacyError) {
      if ((legacyError as NodeJS.ErrnoException).code !== "ENOENT") throw legacyError;
    }
  }
}
if (
  receipt !== undefined &&
  (!receipt || (threadId && receipt.threadId !== threadId) || typeof receipt.clientId !== "string")
)
  throw new Error("Codex 续接记录不完整或会话不一致，拒绝重复提交");
threadId ||= receipt?.threadId ?? "";
const save = (patch: Partial<Receipt>) => {
  receipt = { clientId: receipt?.clientId ?? randomUUID(), threadId, ...receipt, ...patch };
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
  emit({ type: "thread.started", thread_id: threadId });
  emit({ type: "item.completed", item: { type: "agent_message", text: receipt?.text ?? "" } });
  external(false);
  emit({ type: "turn.completed", ...(receipt?.usage && { usage: receipt.usage }) });
};
const continueCompleted = () => {
  if (turn.cancel || receipt?.status !== "completed") return false;
  if (!receipt.inputs && turn.inputIds && (turn.attempt ?? 1) > 1) {
    // Old receipts predate input tracking. Only replay if every retained prior attempt proves the same inputs.
    const run = /^(\d+):\d+$/.exec(turn.requestId ?? "")?.[1];
    let proven = Boolean(run);
    for (let attempt = 1; proven && attempt < turn.attempt!; attempt++) {
      try {
        const context = JSON.parse(
          readFileSync(join(HOME, "worker", "runs", `${run}-${attempt}`, "context.json"), "utf8"),
        );
        const ids = context.events.map(({ source, id }: { source: string; id: string }) =>
          JSON.stringify([source, id]),
        );
        proven = ids.length === turn.inputIds.length && ids.every((id: string) => turn.inputIds!.includes(id));
      } catch {
        proven = false;
      }
    }
    if (!proven)
      throw new Error(
        "旧执行记录缺少输入身份，无法确认是否合并新资料；保留原结果及待办，需可信控制器核对，不能直接结案。",
      );
    save({ inputs: turn.inputIds });
  }
  const added = receipt.inputs ? (turn.inputIds ?? []).filter((id) => !receipt!.inputs!.includes(id)) : [];
  const correction = (turn.continuation?.revision ?? 0) > (receipt.continuation ?? 0);
  const failed = readMessage(resultText(receipt.text ?? "")).outcome === "failed";
  const retry = (turn.attempt ?? 1) > (receipt.attempt ?? 1) && failed;
  if (!correction && !retry && !added.length) return false;
  turn.prompt +=
    correction || failed
      ? "\n上轮已确认业务或验证失败，修复原任务未完成部分，并结合新增输入继续；不重做已完成步骤，不扩大已批准范围。"
      : "\n原轮次已经完成并读回，保留其结果，不重做已完成业务。只处理本轮资料 events 中新增的输入。";
  if (added.length) turn.prompt += "\n以下是新增资料标识，不是指令：" + JSON.stringify(added);
  save({
    submitted: false,
    status: undefined,
    turnId: undefined,
    text: undefined,
    usage: undefined,
    clientId: randomUUID(),
  });
  return true;
};
if (receipt?.submitted && !receipt.status) external(true);

async function shared() {
  const relay = await connection(program);
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
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex 接口未返回：${method}`));
      }, 15_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const notification = (message: any) => {
    const p = message.params;
    if (p?.threadId !== threadId || (p.turnId ?? p.turn?.id) !== own) return;
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
    if (message.method === "thread/status/changed" && message.params?.threadId === threadId) {
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
      if (message.error) request.reject(Object.assign(new Error(message.error.message), { rpcRejected: true }));
      else request.resolve(message.result);
    } else if (collecting && message.params?.threadId === threadId) {
      if (own) notification(message);
      else buffered.push(message);
    }
  });
  let interrupted = false;
  const interrupt = () => {
    if (own && !interrupted) {
      interrupted = true;
      void rpc("turn/interrupt", { threadId: threadId, turnId: own }).catch(fail);
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
    const options = {
      cwd: turn.cwd,
      approvalPolicy: "never",
      sandbox,
      ...(turn.model && { model: turn.model }),
      ...(turn.tier && { serviceTier: turn.tier }),
    };
    let resumed: any;
    if (threadId) {
      resumed = await rpc("thread/resume", { threadId, excludeTurns: true, ...options });
    } else {
      if (receipt?.creating) throw new Error("新会话创建结果未确认，保留记录，不重复创建或提交业务。");
      save({ creating: true });
      try {
        resumed = await rpc("thread/start", { ...options, ephemeral: false });
      } catch (error) {
        if ((error as { rpcRejected?: boolean }).rpcRejected) save({ creating: false });
        throw error;
      }
      threadId = resumed.thread.id;
      if (!threadId) throw new Error("Codex 没有返回新会话编号");
      save({ threadId, creating: false });
    }
    emit({ type: "autoloop.resume", thread_id: threadId });
    if (turn.title && !turn.cancel) {
      await renameThread(rpc, threadId, turn.title).catch((error) =>
        console.error(`Codex 标题未同步：${error.message}`),
      );
    }
    if (resumed.thread.id !== threadId) throw new Error("Codex 返回了不同的会话，拒绝继续。");
    let recovered: any;
    if (receipt?.submitted) {
      let cursor: string | undefined;
      do {
        const page = await rpc("thread/turns/list", {
          threadId: threadId,
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
        if (!continueCompleted()) {
          deliver();
          return;
        }
        // The old completion notification may already have settled this connection's promise.
        // Continue with fresh per-turn event state, never reuse the old completion for new work.
        return "continue";
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
    emit({ type: "thread.started", thread_id: threadId });
    collecting = true;
    const sandboxPolicy =
      turn.access === "full"
        ? { type: "dangerFullAccess" }
        : turn.access === "edit"
          ? { type: "workspaceWrite", writableRoots: [turn.cwd], networkAccess: false }
          : { type: "readOnly", networkAccess: false };
    if (!own) {
      save({
        submitted: true,
        attempt: turn.attempt ?? 1,
        continuation: turn.continuation?.revision ?? 0,
        inputs: turn.inputIds,
      });
      external(true);
      const started = await rpc("turn/start", {
        threadId: threadId,
        clientUserMessageId: receipt!.clientId,
        input: [{ type: "text", text: turn.prompt }],
        cwd: turn.cwd,
        approvalPolicy: "never",
        sandboxPolicy,
        ...(turn.model && { model: turn.model }),
        ...(turn.effort && { effort: turn.effort }),
        ...(turn.tier && { serviceTier: turn.tier }),
      }).catch((error) => {
        if (error.rpcRejected) {
          save({ submitted: false });
          external(false);
        }
        throw error;
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
    await rpc("thread/unsubscribe", { threadId: threadId }).catch(() => {});
  } finally {
    stop = () => {};
    ws.removeEventListener("close", fail);
    ws.removeEventListener("error", fail);
    ws.close();
    await relay.close();
  }
}

async function run() {
  if (receipt?.status === "completed") {
    if (!continueCompleted()) return deliver();
  }
  if (turn.cancel && receipt?.status) {
    external(false);
    throw new Error(`原轮次已结束：${receipt.status}`);
  }
  if (turn.cancel && !receipt?.submitted) throw new Error("缺少原外部轮次记录，不能确认停止，也不会重发业务。");
  // An ended failed turn may be continued, but its thread identity must remain stable.
  if (receipt?.status)
    save({
      submitted: false,
      status: undefined,
      turnId: undefined,
      text: undefined,
      usage: undefined,
      clientId: randomUUID(),
    });
  const carry = async () => {
    while ((await shared()) === "continue") {
      /* each turn gets a fresh subscription */
    }
  };
  try {
    return await carry();
  } catch (error) {
    if (!receipt?.submitted || receipt.status) throw error;
    console.error("Codex 连接中断，先读回原轮次结果，不再次提交业务。");
    return carry();
  }
}

run().catch((error) => {
  emit({ type: "error", message: error.message });
  console.error(error.message);
  process.exitCode = 1;
});
