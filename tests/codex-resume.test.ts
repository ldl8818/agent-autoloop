// A Desktop-loaded thread must resume through its owning server, retaining its identity and history.
// A failed resume must not authorize a fresh session; work already started must never be submitted again.
// Windows needs the same npm-style executable shim as an installed CLI; it cannot spawn a shebang script directly.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import type { Duplex } from "node:stream";
import { test } from "node:test";
import { commandLine } from "../host/command.ts";
import codex from "../plugins/codex/agent.ts";
import { connection } from "../plugins/codex/connection.ts";
import { setup } from "./helpers.ts";

const home = setup("codex-resume");

function executable(script: string) {
  if (process.platform !== "win32") return script;
  const shim = script.replace(/\.cjs$/, ".cmd");
  writeFileSync(shim, `@ECHO off\r\nnode "%~dp0${basename(script)}" %*\r\n`);
  return shim;
}

test("the temporary daemon relay requires its capability before starting the official proxy", async () => {
  const marker = join(home, "proxy-started");
  const program = join(home, "proxy-guard.cjs");
  writeFileSync(
    program,
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'started');\n`,
    { mode: 0o755 },
  );
  const relay = await connection(executable(program));
  const rejected = (url: string) =>
    new Promise<void>((resolve) => {
      const ws = new WebSocket(url);
      ws.addEventListener("error", () => resolve(), { once: true });
    });
  try {
    await rejected(new URL(relay.url).origin + "/wrong-capability");
    assert.equal(existsSync(marker), false);
    await rejected(relay.url);
    assert.equal(existsSync(marker), true);
  } finally {
    await relay.close();
  }
});

async function fixture(mode = "locked") {
  const calls: any[] = [];
  const titled = mode.includes("title");
  const titleBlock = "\n\n```autoloop-title\n网站补抓｜正确识别等待与失败\n```";
  let titleName: string | null = null;
  let finish: (() => void) | undefined;
  let release = () => {};
  let savedTurn: any;
  const sockets = new Set<Duplex>();
  const server = createServer();
  server.on("upgrade", (request, socket) => {
    release = () => {
      if (!socket.destroyed)
        send({ method: "thread/status/changed", params: { threadId: "original", status: { type: "idle" } } });
    };
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const accept = createHash("sha1")
      .update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
        accept +
        "\r\n\r\n",
    );
    const send = (value: object) => {
      const body = Buffer.from(JSON.stringify(value));
      const header =
        body.length < 126
          ? Buffer.from([129, body.length])
          : Buffer.from([129, 126, body.length >> 8, body.length & 255]);
      socket.write(Buffer.concat([header, body]));
    };
    let buffer = Buffer.alloc(0);
    socket.on("data", (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15;
        let size = buffer[1] & 127;
        let offset = 2;
        if (size === 126) {
          if (buffer.length < 4) return;
          size = buffer.readUInt16BE(2);
          offset = 4;
        } else if (size === 127) {
          if (buffer.length < 10) return;
          size = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffer.length < offset + 4 + size) return;
        const mask = buffer.subarray(offset, offset + 4);
        const payload = buffer.subarray(offset + 4, offset + 4 + size);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        buffer = buffer.subarray(offset + 4 + size);
        if (opcode === 8) return socket.end(Buffer.from([136, 0]));
        if (opcode !== 1) continue;
        const message = JSON.parse(payload.toString());
        calls.push(message);
        const reply = (result: object) => send({ id: message.id, result });
        if (message.method === "initialize") reply({ userAgent: "test" });
        if (message.method === "thread/read") reply({ thread: { id: "original", name: titleName } });
        if (message.method === "thread/name/set") {
          if (mode === "new-title-failure")
            send({ id: message.id, error: { code: -1, message: "metadata unavailable" } });
          else {
            titleName = message.params.name;
            reply({});
          }
        }
        if (message.method === "thread/resume" || message.method === "thread/start")
          reply({
            thread: {
              id: "original",
              status: { type: mode === "busy" || savedTurn?.status === "inProgress" ? "active" : "idle" },
            },
          });
        if (message.method === "thread/turns/list") {
          if (mode === "recovered-new-input" && savedTurn?.status === "completed")
            send({ method: "turn/completed", params: { threadId: "original", turn: savedTurn } });
          reply({ data: savedTurn ? [savedTurn] : [] });
          if (mode === "drop-message" && savedTurn?.status === "inProgress")
            setTimeout(() => {
              savedTurn.status = "completed";
              send({
                method: "turn/completed",
                params: { threadId: "original", turn: { id: "own", status: "completed" } },
              });
            }, 10);
        }
        if (message.method === "turn/start") {
          savedTurn = {
            id: calls.filter((x) => x.method === "turn/start").length === 1 ? "own" : "own-2",
            status: "inProgress",
            items: [
              { type: "userMessage", clientId: message.params.clientUserMessageId, content: message.params.input },
            ],
          };
          if (mode === "drop-complete" || mode === "drop-title") {
            savedTurn.status = "completed";
            savedTurn.items.push({
              type: "agentMessage",
              text: "recovered completed result" + (titled ? titleBlock : ""),
            });
          }
          if (mode === "drop-message") savedTurn.items.push({ type: "agentMessage", text: "recovered final message" });
          finish = () => {
            savedTurn.status = "completed";
            send({
              method: "item/completed",
              params: { threadId: "other", turnId: "own", item: { type: "agentMessage", text: "wrong thread" } },
            });
            send({
              method: "item/completed",
              params: { threadId: "original", turnId: "old", item: { type: "agentMessage", text: "old answer" } },
            });
            send({
              method: "item/completed",
              params: {
                threadId: "original",
                turnId: savedTurn.id,
                item: {
                  type: "agentMessage",
                  text:
                    mode === "business-failed"
                      ? "没跑成：临时服务不可用"
                      : "remembered context: iris-728; blue" + (titled ? titleBlock : ""),
                },
              },
            });
            send({
              method: "thread/tokenUsage/updated",
              params: {
                threadId: "original",
                turnId: savedTurn.id,
                tokenUsage: { total: { inputTokens: 120, cachedInputTokens: 80, outputTokens: 9 } },
              },
            });
            send({
              method: "turn/completed",
              params: { threadId: "original", turn: { id: savedTurn.id, status: "completed" } },
            });
          };
          // Notifications can arrive before the turn/start response.
          send({ method: "turn/started", params: { threadId: "original", turn: { id: "own" } } });
          reply({ turn: { id: savedTurn.id } });
          if (mode.startsWith("drop-")) socket.destroy();
          else if (
            mode !== "cancel" &&
            (!["new-correction", "recovered-new-input"].includes(mode) || savedTurn.id === "own")
          )
            finish();
        }
        if (message.method === "turn/interrupt") {
          savedTurn.status = "interrupted";
          reply({});
          send({
            method: "turn/completed",
            params: { threadId: "original", turn: { id: savedTurn.id, status: "interrupted" } },
          });
        }
        if (message.method === "thread/unsubscribe") {
          if (mode === "unsubscribe-drop") socket.destroy();
          else reply({ status: "unsubscribed" });
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const program = join(home, `codex-${mode}.cjs`);
  writeFileSync(
    program,
    `#!/usr/bin/env node
const net = require("node:net");
if (process.argv[2] === "app-server") {
  const socket = net.connect(${port}, "127.0.0.1");
  process.stdin.pipe(socket); socket.pipe(process.stdout);
  process.stdin.on("end", () => socket.end()); socket.on("close", () => process.exit(0));
} else if (${JSON.stringify(mode)} === "normal") {
  console.log(JSON.stringify({type:"thread.started",thread_id:"original"}));
  console.log(JSON.stringify({type:"turn.started"}));
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"normal resume"}}));
  console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:3,output_tokens:1,cached_input_tokens:0}}));
} else {
  if (${JSON.stringify(mode)} === "started-error") console.log(JSON.stringify({type:"turn.started"}));
  console.error("thread-store conflict: thread original already has an active writer"); process.exitCode=1;
}
`,
    { mode: 0o755 },
  );
  const argv = codex.command({
    prompt: "finish blue",
    ...(titled && { title: "autoloop-decision-129｜caipiao-development-decision-129-decision-129" }),
    resume: mode.startsWith("new-") ? null : "original",
    session: "original",
    cwd: home,
    access: mode === "new-full" ? "full" : "read",
    model: "configured-model",
    effort: "low",
    tier: "priority",
    contextFile: join(home, "context.json"),
    folder: home,
    program: executable(program),
    requestId: mode === "legacy-inputs" ? "90017:0" : mode + randomUUID(),
    inputIds: ['["local","original-event"]'],
  });
  const [command, args] = commandLine(argv);
  const children: ReturnType<typeof spawn>[] = [];
  const launch = (overrides?: number | object) => {
    const nextArgs = [...args];
    if (overrides) {
      const request = JSON.parse(nextArgs.at(-1)!);
      Object.assign(request.turn, typeof overrides === "number" ? { attempt: overrides } : overrides);
      nextArgs[nextArgs.length - 1] = JSON.stringify(request);
    }
    const child = spawn(command, nextArgs, { cwd: home });
    children.push(child);
    let stdout = "",
      stderr = "";
    child.stdout!.on("data", (chunk) => (stdout += chunk));
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    const done = new Promise<{ code: number | null; out: string; err: string }>((resolve) =>
      child.on("close", (code) => resolve({ code, out: stdout, err: stderr })),
    );
    return { child, done };
  };
  const { child, done } = launch();
  return {
    calls,
    receiptFile: join(
      home,
      "worker",
      "codex",
      createHash("sha256")
        .update(JSON.stringify(JSON.parse(args.at(-1)!).turn.requestId))
        .digest("hex") + ".json",
    ),
    release: () => release(),
    child,
    done,
    again: launch,
    async close() {
      for (const child of children) child.kill();
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test(
  "Codex resumes a Desktop-owned thread through the owning daemon without losing context",
  { skip: process.platform === "win32" },
  async () => {
    const f = await fixture();
    try {
      const result = await f.done;
      const reading = codex.read(result.out, result.code, result.err);
      assert.equal(reading.text, "remembered context: iris-728; blue");
      assert.equal(reading.session, "original");
      assert.equal(f.calls.filter((x) => x.method === "turn/start").length, 1);
      const turn = f.calls.find((x) => x.method === "turn/start").params;
      assert.equal(turn.threadId, "original");
      assert.equal(turn.approvalPolicy, "never");
      assert.deepEqual(turn.sandboxPolicy, { type: "readOnly", networkAccess: false });
      assert.equal(turn.model, "configured-model");
      assert.equal(turn.effort, "low");
      assert.equal(turn.serviceTier, "priority");
      assert.deepEqual(reading.sessionUsage, { input: 120, output: 9, cached: 80 });
    } finally {
      await f.close();
    }
  },
);

test(
  "Codex reads back a result lost with the shared connection and replays the receipt without rerunning work",
  { skip: process.platform === "win32" },
  async () => {
    const f = await fixture("drop-complete");
    try {
      const first = await f.done;
      assert.equal(codex.read(first.out, first.code, first.err).text, "recovered completed result");
      const second = await f.again().done;
      assert.equal(codex.read(second.out, second.code, second.err).text, "recovered completed result");
      assert.equal(f.calls.filter((x) => x.method === "turn/start").length, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  "Codex reconnects to its running shared turn before cancelling after a proxy disconnect",
  { skip: process.platform === "win32" },
  async () => {
    const f = await fixture("drop-active");
    try {
      const deadline = Date.now() + 5000;
      while (!f.calls.some((x) => x.method === "thread/turns/list")) {
        assert.ok(Date.now() < deadline, "did not recover the existing turn");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      f.child!.kill("SIGTERM");
      const r = await f.done;
      const reading = codex.read(r.out, r.code, r.err);
      assert.ok(reading.error);
      assert.equal(reading.external, false);
      assert.equal(f.calls.filter((x) => x.method === "turn/start").length, 1);
      assert.deepEqual(
        f.calls.filter((x) => x.method === "turn/interrupt").map((x) => x.params),
        [{ threadId: "original", turnId: "own" }],
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "Codex restores a saved message before receiving the recovered turn's completion",
  { skip: process.platform === "win32" },
  async () => {
    const f = await fixture("drop-message");
    try {
      const r = await f.done;
      assert.equal(codex.read(r.out, r.code, r.err).text, "recovered final message");
      const replay = await f.again().done;
      assert.equal(codex.read(replay.out, replay.code, replay.err).text, "recovered final message");
      assert.equal(f.calls.filter((x) => x.method === "turn/start").length, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  "Codex waits for a busy original session, then automatically submits its turn once",
  { skip: process.platform === "win32" },
  async () => {
    const f = await fixture("busy");
    try {
      const deadline = Date.now() + 5000;
      while (!f.calls.some((x) => x.method === "thread/resume")) {
        assert.ok(Date.now() < deadline);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(f.calls.filter((x) => x.method === "turn/start").length, 0);
      f.release();
      const r = await f.done;
      const reading = codex.read(r.out, r.code, r.err);
      assert.equal(reading.session, "original");
      assert.equal(reading.started, true, "the worker must preserve the original session");
      assert.equal(reading.text, "remembered context: iris-728; blue");
      assert.equal(reading.error, undefined);
      assert.equal(f.calls.filter((x) => x.method === "turn/start").length, 1);
    } finally {
      await f.close();
    }
  },
);

test("read-only tasks return a semantic title that the host names without adding a business turn", async () => {
  const f = await fixture("new-title");
  try {
    const r = await f.done;
    assert.equal(r.code, 0, r.err);
    const submit = f.calls.find((x) => x.method === "turn/start");
    assert.match(submit.params.input[0].text, /Codex会话分区\.md/);
    assert.match(submit.params.input[0].text, /中文模块名｜持续目标/);
    assert.equal(submit.params.sandboxPolicy.networkAccess, false);
    const writes = () => f.calls.filter((x) => x.method === "thread/name/set");
    assert.deepEqual(writes()[0].params, { threadId: "original", name: "autoloop-网站补抓｜正确识别等待与失败" });
    assert.equal(f.calls.filter((x) => x.method === "thread/read").length, 3);
    const replay = await f.again().done;
    assert.equal(replay.code, 0, replay.err);
    assert.equal(writes().length, 1);
    assert.equal(f.calls.filter((x) => x.method === "thread/start").length, 1);
    assert.equal(f.calls.filter((x) => x.method === "turn/start").length, 1);
    assert.equal(codex.read(r.out, r.code, r.err).text, "remembered context: iris-728; blue");
    assert.equal(codex.read(replay.out, replay.code, replay.err).text, "remembered context: iris-728; blue");
    const saved = JSON.parse(readFileSync(f.receiptFile, "utf8"));
    assert.equal(saved.text, "remembered context: iris-728; blue");
    assert.equal(saved.title, "autoloop-网站补抓｜正确识别等待与失败");
  } finally {
    await f.close();
  }
});

test("host naming failures retain the completed business receipt and never resubmit the task", async () => {
  const f = await fixture("new-title-failure");
  try {
    const r = await f.done;
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /Codex 标题未同步/);
    assert.equal(codex.read(r.out, r.code, r.err).text, "remembered context: iris-728; blue");
    const replay = await f.again().done;
    assert.equal(replay.code, 0, replay.err);
    assert.equal(f.calls.filter((x) => x.method === "turn/start").length, 1);
  } finally {
    await f.close();
  }
});

test("a recovered completed result names the original session and strips private title metadata", async () => {
  const f = await fixture("drop-title");
  try {
    const lost = await f.done;
    assert.equal(lost.code, 0, lost.err);
    assert.match(lost.err, /Codex 连接中断/);
    assert.equal(codex.read(lost.out, lost.code, lost.err).text, "recovered completed result");
    const recovered = await f.again().done;
    assert.equal(recovered.code, 0, recovered.err);
    assert.equal(codex.read(recovered.out, recovered.code, recovered.err).text, "recovered completed result");
    assert.deepEqual(f.calls.find((x) => x.method === "thread/name/set").params, {
      threadId: "original",
      name: "autoloop-网站补抓｜正确识别等待与失败",
    });
    assert.equal(f.calls.filter((x) => x.method === "turn/start").length, 1);
    assert.equal(f.calls.filter((x) => x.method === "thread/start").length, 0);
  } finally {
    await f.close();
  }
});

test("Codex creates new tasks on the shared server with full access and replays a completed launch once", async () => {
  const f = await fixture("new-full");
  try {
    const r = await f.done;
    const reading = codex.read(r.out, r.code, r.err);
    assert.equal(reading.error, undefined);
    assert.equal(reading.session, "original");
    assert.equal(reading.text, "remembered context: iris-728; blue");
    const start = f.calls.find((x) => x.method === "thread/start");
    assert.equal(start.params.sandbox, "danger-full-access");
    assert.equal(start.params.approvalPolicy, "never");
    const submit = f.calls.find((x) => x.method === "turn/start");
    assert.deepEqual(submit.params.sandboxPolicy, { type: "dangerFullAccess" });
    assert.equal(submit.params.approvalPolicy, "never");
    const replay = await f.again().done;
    assert.equal(codex.read(replay.out, replay.code, replay.err).text, reading.text);
    assert.equal(f.calls.filter((x) => x.method === "thread/start").length, 1);
    assert.equal(f.calls.filter((x) => x.method === "turn/start").length, 1);
  } finally {
    await f.close();
  }
});

test("a confirmed business failure retries in its original thread while the same attempt only replays", async () => {
  const f = await fixture("business-failed");
  try {
    const first = await f.done;
    assert.equal(codex.read(first.out, first.code, first.err).text, "没跑成：临时服务不可用");
    await f.again().done;
    assert.equal(f.calls.filter((x) => x.method === "turn/start").length, 1);
    const next = { attempt: 2, inputIds: ['["local","original-event"]', '["answer","new-answer"]'] };
    const second = await f.again(next).done;
    assert.equal(codex.read(second.out, second.code, second.err).session, "original");
    const submitted = f.calls.filter((x) => x.method === "turn/start");
    assert.equal(submitted.length, 2);
    assert.notEqual(submitted[0].params.clientUserMessageId, submitted[1].params.clientUserMessageId);
    assert.match(submitted[1].params.input[0].text, /修复原任务未完成部分/);
    assert.match(submitted[1].params.input[0].text, /new-answer/);
    await f.again(next).done;
    assert.equal(f.calls.filter((x) => x.method === "turn/start").length, 2);
  } finally {
    await f.close();
  }
});

test("validation correction keeps the new thread and root cancellation targets its current turn", async () => {
  const f = await fixture("new-correction");
  try {
    await f.done;
    f.again({ continuation: { revision: 1, reason: "verification failed" } });
    const deadline = Date.now() + 5000;
    while (f.calls.filter((x) => x.method === "turn/start").length < 2) {
      assert.ok(Date.now() < deadline, "corrective turn did not start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const stopped = await f.again({ cancel: true }).done;
    assert.equal(codex.read(stopped.out, stopped.code, stopped.err).external, false);
    assert.deepEqual(
      f.calls.filter((x) => x.method === "turn/interrupt").map((x) => x.params),
      [{ threadId: "original", turnId: "own-2" }],
    );
    assert.equal(f.calls.filter((x) => x.method === "thread/start").length, 1);
    assert.equal(f.calls.filter((x) => x.method === "turn/start").length, 2);
  } finally {
    await f.close();
  }
});

test("new inputs merged after a lost completed response are continued once without discarding the original result", async () => {
  const f = await fixture("drop-complete");
  try {
    await f.done;
    const next = { attempt: 2, inputIds: ['["local","original-event"]', '["answer","new-answer"]'] };
    const r = await f.again(next).done;
    assert.equal(codex.read(r.out, r.code, r.err).session, "original");
    const starts = f.calls.filter((x) => x.method === "turn/start");
    assert.equal(starts.length, 2);
    assert.match(starts[1].params.input[0].text, /只处理.*新增/);
    assert.match(starts[1].params.input[0].text, /new-answer/);
    assert.match(starts[1].params.input[0].text, /不重做已完成业务/);
    await f.again(next).done;
    assert.equal(f.calls.filter((x) => x.method === "turn/start").length, 2);
  } finally {
    await f.close();
  }
});

test("an old completion arriving during recovery cannot finish newly merged work", async () => {
  const f = await fixture("recovered-new-input");
  try {
    await f.done;
    const old = JSON.parse(readFileSync(f.receiptFile, "utf8"));
    delete old.status;
    writeFileSync(f.receiptFile, JSON.stringify(old));
    let ended = false;
    const correction = f.again({ attempt: 2, inputIds: ['["local","original-event"]', '["answer","new-answer"]'] });
    void correction.done.then(() => {
      ended = true;
    });
    const deadline = Date.now() + 5000;
    while (f.calls.filter((x) => x.method === "turn/start").length < 2) {
      assert.ok(Date.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(ended, false);
    const stopped = await f.again({ cancel: true }).done;
    assert.equal(codex.read(stopped.out, stopped.code, stopped.err).external, false);
    assert.equal(f.calls.findLast((x) => x.method === "turn/interrupt").params.turnId, "own-2");
  } finally {
    await f.close();
  }
});

test("legacy completed receipts need proof of unchanged inputs before settling a later attempt", async () => {
  const f = await fixture("legacy-inputs");
  try {
    await f.done;
    const old = JSON.parse(readFileSync(f.receiptFile, "utf8"));
    delete old.inputs;
    writeFileSync(f.receiptFile, JSON.stringify(old));
    const unknown = await f.again({ attempt: 2 }).done;
    assert.match(codex.read(unknown.out, unknown.code, unknown.err).error!, /缺少输入身份/);
    assert.equal(f.calls.filter((x) => x.method === "turn/start").length, 1);
    const prior = join(home, "worker", "runs", "90017-1");
    mkdirSync(prior, { recursive: true });
    writeFileSync(join(prior, "context.json"), JSON.stringify({ events: [{ source: "local", id: "original-event" }] }));
    const proven = await f.again({ attempt: 2 }).done;
    assert.equal(codex.read(proven.out, proven.code, proven.err).text, "remembered context: iris-728; blue");
    assert.equal(f.calls.filter((x) => x.method === "turn/start").length, 1);
  } finally {
    await f.close();
  }
});

test(
  "Codex keeps a completed result if the connection closes during unsubscribe",
  { skip: process.platform === "win32" },
  async () => {
    const f = await fixture("unsubscribe-drop");
    try {
      const r = await f.done;
      const reading = codex.read(r.out, r.code, r.err);
      assert.equal(reading.text, "remembered context: iris-728; blue");
      assert.equal(reading.error, undefined);
      assert.equal(f.calls.filter((x) => x.method === "turn/start").length, 1);
    } finally {
      await f.close();
    }
  },
);

test("Codex cancellation interrupts its own shared turn", { skip: process.platform === "win32" }, async () => {
  const f = await fixture("cancel");
  try {
    const deadline = Date.now() + 5000;
    while (!f.calls.some((x) => x.method === "turn/start")) {
      assert.ok(Date.now() < deadline, "turn did not start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    f.child.kill("SIGTERM");
    const r = await f.done;
    assert.ok(codex.read(r.out, r.code, r.err).error);
    assert.deepEqual(
      f.calls.filter((x) => x.method === "turn/interrupt").map((x) => x.params),
      [{ threadId: "original", turnId: "own" }],
    );
    assert.equal(f.calls.filter((x) => x.method === "turn/start").length, 1);
  } finally {
    await f.close();
  }
});
