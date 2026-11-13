// What's different about ZCode. Failure cases: a level of access maps to the wrong permission mode, or a prompt runs in
// yolo when the rule asked for read/edit; a resumed turn starts a new session instead of going on; the final JSON is
// read line by line (it is one pretty-printed object) or a warning before it hides the answer; a still-running turn is
// taken for an answer or a failure, or output cut off inside the object hangs the worker that reads it; an unknown
// resumed session is retried in that same session forever instead of starting a new one; a run that exited without JSON
// is taken for a success; the provider's tokens are dropped; a Windows .cjs bundle is run as if the platform could
// execute it; the version check passes when the program is missing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

type Adapter = import("../worker/agents.ts").Adapter;
const zcode: Adapter = (await import("../plugins/zcode/agent.ts")).default;
const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-zcode-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const turn = {
  prompt: "做这件事",
  session: "new-id",
  resume: null,
  cwd: "/x",
  access: "edit" as const,
  contextFile: "/ctx.json",
  folder: "/run",
};
const withProgram = (over: object = {}) => zcode.command({ ...turn, program: "/test/zcode", ...over });

test("ZCode: access is its own mode, and a resumed turn goes on in its session", () => {
  assert.deepEqual(withProgram(), [
    "/test/zcode",
    "--mode",
    "edit",
    "--surface",
    "terminal",
    "--no-color",
    "--json",
    "-p",
    "做这件事",
  ]);
  assert.equal(withProgram({ access: "read" })[2], "plan");
  assert.equal(withProgram({ access: "full" })[2], "yolo");
  assert.deepEqual(withProgram({ resume: "sess_1" }).slice(-4), ["--resume", "sess_1", "-p", "做这件事"]);
  assert.ok(!withProgram().includes("--resume"), "a new session takes no id: ZCode makes its own and reports it");
  assert.ok(
    !withProgram({ model: "m", effort: "high" }).includes("m"),
    "ZCode takes model and effort from its own settings",
  );
});

test("ZCode: a .cjs bundle is started by node, not executed as if the platform could", () => {
  assert.deepEqual(zcode.command({ ...turn, program: "/opt/zcode.cjs" }).slice(0, 2), [
    process.execPath,
    "/opt/zcode.cjs",
  ]);
});

const answer = (over: object = {}) =>
  JSON.stringify(
    {
      sessionId: "sess_1",
      traceId: "trace-1",
      turnId: "turn-1",
      response: "好了",
      usage: {
        source: "provider",
        modelRequestCount: 1,
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        cacheReadTokens: 5,
        cacheWriteTokens: 7,
        reasoningTokens: 0,
        webFetchRequests: 0,
        webSearchRequests: 0,
      },
      ...over,
    },
    null,
    2,
  );

test("ZCode: the final JSON's response is the answer, with the session and the provider's tokens", () => {
  assert.deepEqual(zcode.read(answer(), 0, ""), {
    text: "好了",
    session: "sess_1",
    usage: { input: 10, output: 2, cached: 5 },
    started: true,
    finished: true,
  });
  // A warning printed before the object must not hide it.
  assert.equal(zcode.read(`warning: provider said something\n${answer()}`, 0, "").text, "好了");
});

test("ZCode: still running is not an answer and not a failure, and counts as started", () => {
  assert.deepEqual(zcode.read("", null, ""), { started: true });
  assert.deepEqual(zcode.read('{"sessionId":"sess_1"', null, ""), { started: true });
  // Cut off after a brace inside the answer: no object yet, and reading it must return.
  assert.deepEqual(zcode.read('{"sessionId":"sess_1","response":"用 {x} 写', null, ""), { started: true });
});

test("ZCode: an unknown resumed session may start a new one; another failure stays in this one", () => {
  const missing = zcode.read("", 1, "Error: Session not found: sess_0 (traceId: x)\nstack");
  assert.equal(missing.started, false);
  assert.match(missing.error!, /Session not found/);
  assert.deepEqual(zcode.read("", 1, "boom"), { started: true, error: "boom" });
  assert.deepEqual(zcode.read("", 0, ""), { started: true, error: "ZCode 没有完成并留下实际结果" });
});

test("ZCode: a finished run without a response is not a result", () => {
  const reading = zcode.read(answer({ response: "  " }), 0, "");
  assert.equal(reading.text, undefined);
  assert.equal(reading.started, true);
  assert.equal(reading.error, "ZCode 没有完成并留下实际结果");
});

test("ZCode: check runs version, and says what to do when the program is missing", () => {
  const fake = join(scratch, "zcode.cjs");
  writeFileSync(fake, 'if (process.argv[2] === "version") console.log("0.17.1"); else process.exit(1);');
  assert.equal(zcode.check!(fake), null);
  assert.match(zcode.check!(join(scratch, "missing.cjs"))!, /^ZCode 用不了：/);
});
