// What's different about DSH. Failure cases: a level of access maps to the wrong permission preset, or a resumed turn keeps
// the one its session was saved with; a call that needs approval waits for someone who isn't there; a resumed turn starts a
// new session; a run that's still going, or whose turn has ended while its background work finishes, is taken for an answer
// or a failure, and stopped; a run that ended in an error or without an answer is taken for a result; the token counts of a
// run's several steps are dropped, or its input leaves out the cache's reads and writes; a program that's missing, broken or too old to take these options passes for usable, or
// a mistake it can only report on stdout is lost. The events are the shapes in DSH's own
// packages/bundle/headless/src/json-stream.ts and startup.ts; its real program has not been run here. The program is looked up through the login shell, so this points the shell and HOME at
// this test's own instead of whatever this machine has installed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

type Adapter = import("../worker/agents.ts").Adapter;

const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-dsh-"));
const usual = { SHELL: process.env.SHELL, HOME: process.env.HOME };
const program = join(scratch, "dsh");
const shell = join(scratch, "shell");
writeFileSync(
  program,
  `#!/bin/sh
[ "\${DSH_TEST_USABLE:-}" = "" ] && { echo "dsh: cannot run" >&2; exit 1; }
[ "$1 $2" = "headless --help" ] || { echo "dsh: unexpected $*" >&2; exit 1; }
echo "  --json"
[ "\${DSH_TEST_USABLE:-}" = old ] || echo "  --approval-policy <policy>"
`,
  { mode: 0o755 },
);
// What a login shell prints for `command -v dsh`; an empty DSH_TEST_PROGRAM stands in for dsh not being there.
writeFileSync(shell, '#!/bin/sh\nprintf "%s\\n" "$DSH_TEST_PROGRAM"\n', { mode: 0o755 });
process.env.SHELL = shell;
process.env.HOME = scratch;
process.env.DSH_TEST_PROGRAM = program;
after(() => {
  rmSync(scratch, { recursive: true, force: true });
  for (const [name, value] of Object.entries(usual)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  delete process.env.DSH_TEST_PROGRAM;
});
const dsh: Adapter = (await import("../plugins/dsh/agent.ts")).default;
const check = dsh.check!;

const turn = {
  prompt: "做这件事",
  session: "new-id",
  resume: null,
  cwd: "/x",
  access: "edit" as const,
  contextFile: "/ctx.json",
  folder: "/run",
};

test("DSH: access is the permission preset every time, nothing waits for approval, and a resumed turn goes on in its session", () => {
  const policy = ["--approval-policy", "never"];
  const argv = dsh.command(turn);
  assert.deepEqual(argv.slice(0, 3), [program, "headless", "--json"]);
  assert.deepEqual(
    argv.slice(3),
    ["--permission-mode", "workspace-write", ...policy, "做这件事"],
    "a new session takes no id: dsh makes its own and reports it",
  );
  for (const [access, preset] of [
    ["read", "read-only"],
    ["edit", "workspace-write"],
    ["full", "danger-full-access"],
  ] as const) {
    assert.deepEqual(dsh.command({ ...turn, access }).slice(3, 5), ["--permission-mode", preset]);
  }
  const again = dsh.command({ ...turn, access: "read", resume: "session-1" });
  assert.deepEqual(again.slice(3), [
    "--permission-mode",
    "read-only",
    ...policy,
    "--session-id",
    "session-1",
    "做这件事",
  ]);
});

const lines = (...events: object[]) => events.map((event) => JSON.stringify(event)).join("\n");
const opened = { type: "session", sessionId: "session-1", cwd: "/x" };
const step = (usage: object) => ({ type: "status", phase: "step_end", usage });
const turnEnded = (reason: object) => ({ type: "status", phase: "turn_end", turn: 1, reason });
const final = (text: string, reason: object | null) => ({ type: "final", sessionId: "session-1", reason, text });
const completed = { kind: "completed" };

test("DSH: a completed turn's final text is its answer, with every step's tokens added up", () => {
  const reading = dsh.read(
    lines(
      opened,
      { type: "thinking", text: "想一想" },
      { type: "status", phase: "step_start" },
      step({ inputTokens: 7500, outputTokens: 2, cacheReadTokens: 5120, cacheWriteTokens: 0, totalTokens: 12622 }),
      { type: "text", text: "中途" },
      { type: "tool_call", callId: "1", tool: "read", input: {} },
      { type: "tool_result", callId: "1", status: "completed", result: "资料" },
      step({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 1 }),
      turnEnded(completed),
      final("好了", completed),
    ),
    0,
    "",
  );
  assert.deepEqual(reading, {
    session: "session-1",
    usage: { input: 12631, output: 6, cached: 5121 },
    started: true,
    finished: true,
    text: "好了",
  });
});

test("DSH: a turn that's still going has no answer and no error", () => {
  const reading = dsh.read(
    lines(opened, step({ inputTokens: 7, outputTokens: 1, cacheReadTokens: 2 }), { type: "text", text: "中途" }),
    null,
    "",
  );
  assert.equal(reading.text, undefined, "what it said so far isn't its answer");
  assert.equal(reading.error, undefined, "still going isn't a failure");
  assert.deepEqual(reading, {
    session: "session-1",
    usage: { input: 9, output: 1, cached: 2 },
    started: true,
  });
  // A turn has ended, but the run waits on its background work, which may start another: it isn't over until `final`.
  assert.deepEqual(dsh.read(lines(opened, turnEnded(completed), { type: "text", text: "中途" }), null, ""), {
    session: "session-1",
    started: true,
  });
  // `final` with no reason: the last turn never closed.
  const unclosed = dsh.read(lines(opened, final("好了", null)), 1, "");
  assert.equal(unclosed.text, undefined);
  assert.equal(unclosed.error, "DSH 没跑完这一轮");
});

test("DSH: why the turn ended is the reason it failed", () => {
  for (const [reason, error] of [
    [{ kind: "error", error: { message: "额度用完了" } }, "额度用完了"],
    [{ kind: "error" }, "DSH 没跑完这一轮"],
    [{ kind: "aborted" }, "这一轮被中止了"],
    [{ kind: "blocked" }, "这一轮被卡住了，没有完成"],
    [{ kind: "max-tokens" }, "这一轮用完了输出上限"],
    [{ kind: "interrupted" }, "DSH 没跑完这一轮"],
  ] as const) {
    assert.deepEqual(dsh.read(lines(opened, turnEnded(reason), final("好了", reason)), 1, ""), {
      session: "session-1",
      started: true,
      finished: true,
      error,
    });
  }
  const empty = dsh.read(lines(opened, final("  ", completed)), 0, "");
  assert.equal(empty.finished, true);
  assert.equal(empty.text, undefined, "a blank message isn't an answer");
  assert.equal(empty.error, "DSH 没有完成并留下实际结果");
});

test("DSH: a run that ended with no final event falls back to its exit", () => {
  assert.equal(dsh.read("", 3, "cannot start").error, "退出码 3：cannot start");
  assert.equal(dsh.read("", 3, "").error, "退出码 3：没留下原因");
  assert.equal(dsh.read("", 0, "boom").error, "boom");
  assert.equal(dsh.read("", 0, "").error, "DSH 没有完成并留下实际结果");
  assert.deepEqual(dsh.read("", null, "still starting"), {}, "running, so nothing to report yet");
});

test("DSH: a mistake only reported on stdout is the reason it gives", () => {
  const refused = JSON.stringify({ type: "error", message: "unknown option '--permission-mode'" });
  assert.equal(dsh.read(refused, 1, "").error, "退出码 1：unknown option '--permission-mode'");
});

test("DSH: a line of output that's JSON but no event is noise", () => {
  const noise = 'null\n42\n"words"\n[]\n';
  assert.doesNotThrow(() => dsh.read(noise, null, ""));
  assert.doesNotThrow(() => dsh.read(noise, 0, ""));
});

test("DSH: check passes when the program runs, and says what to do when it doesn't", () => {
  assert.match(check()!, /^DSH 用不了：运行 dsh headless "hi" 看看（/);
  process.env.DSH_TEST_USABLE = "old";
  try {
    assert.match(check()!, /版本太旧/);
    process.env.DSH_TEST_USABLE = "1";
    assert.equal(check(), null);
  } finally {
    delete process.env.DSH_TEST_USABLE;
  }
});

test("DSH: check says what to do when dsh isn't installed", () => {
  const empty = join(scratch, "empty");
  const script = `const { default: dsh } = await import(${JSON.stringify(
    new URL("../plugins/dsh/agent.ts", import.meta.url).href,
  )}); process.stdout.write(String(dsh.check()));`;
  // A separate process: the program is looked up once per process, and this one has already found the stub.
  const checked = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script],
    {
      env: { ...process.env, HOME: empty, DSH_TEST_PROGRAM: "" },
      encoding: "utf8",
    },
  );
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /^DSH 用不了：.*找不到 dsh/);
});
