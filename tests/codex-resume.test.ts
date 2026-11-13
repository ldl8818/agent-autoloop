// A Desktop-loaded thread must resume through its owning server, retaining its identity and history.
// A failed resume must not authorize a fresh session; work already started must never be submitted again.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { test } from "node:test";
import { commandLine } from "../host/command.ts";
import codex from "../plugins/codex/agent.ts";
import { connection } from "../plugins/codex/connection.ts";
import { setup } from "./helpers.ts";

const home = setup("codex-resume");

test("the temporary daemon relay requires its capability before starting the official proxy", async () => {
  const marker = join(home, "proxy-started");
  const program = join(home, "proxy-guard.cjs");
  writeFileSync(
    program,
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'started');\n`,
    { mode: 0o755 },
  );
  const relay = await connection(program);
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
        if (message.method === "thread/resume")
          reply({
            thread: {
              id: "original",
              status: { type: mode === "busy" || savedTurn?.status === "inProgress" ? "active" : "idle" },
            },
          });
        if (message.method === "thread/turns/list") {
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
            id: "own",
            status: "inProgress",
            items: [
              { type: "userMessage", clientId: message.params.clientUserMessageId, content: message.params.input },
            ],
          };
          if (mode === "drop-complete") {
            savedTurn.status = "completed";
            savedTurn.items.push({ type: "agentMessage", text: "recovered completed result" });
          }
          if (mode === "drop-message") savedTurn.items.push({ type: "agentMessage", text: "recovered final message" });
          finish = () => {
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
                turnId: "own",
                item: { type: "agentMessage", text: "remembered context: iris-728; blue" },
              },
            });
            send({
              method: "thread/tokenUsage/updated",
              params: {
                threadId: "original",
                turnId: "own",
                tokenUsage: { total: { inputTokens: 120, cachedInputTokens: 80, outputTokens: 9 } },
              },
            });
            send({
              method: "turn/completed",
              params: { threadId: "original", turn: { id: "own", status: "completed" } },
            });
          };
          // Notifications can arrive before the turn/start response.
          send({ method: "turn/started", params: { threadId: "original", turn: { id: "own" } } });
          reply({ turn: { id: "own" } });
          if (mode.startsWith("drop-")) socket.destroy();
          else if (mode !== "cancel") finish();
        }
        if (message.method === "turn/interrupt") {
          savedTurn.status = "interrupted";
          reply({});
          send({
            method: "turn/completed",
            params: { threadId: "original", turn: { id: "own", status: "interrupted" } },
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
    resume: "original",
    session: "original",
    cwd: home,
    access: "read",
    model: "configured-model",
    effort: "low",
    tier: "priority",
    contextFile: join(home, "context.json"),
    folder: home,
    program,
    requestId: mode,
  });
  const [command, args] = commandLine(argv);
  const children: ReturnType<typeof spawn>[] = [];
  const launch = () => {
    const child = spawn(command, args, { cwd: home });
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

test("Codex normal resumes and failed turns that already started never enter the shared retry", async () => {
  for (const mode of ["normal", "started-error"]) {
    const f = await fixture(mode);
    try {
      const r = await f.done;
      const reading = codex.read(r.out, r.code, r.err);
      assert.equal(reading.started, true);
      assert.equal(reading.session, "original");
      assert.equal(f.calls.length, 0);
      if (mode === "normal") assert.equal(reading.text, "normal resume");
      else assert.ok(reading.error);
    } finally {
      await f.close();
    }
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
