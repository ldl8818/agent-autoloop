// Autoloop-owned sessions need a recognizable native title without resubmitting work.
// A failed metadata connection must preserve both completed output and the original exit status.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import codex from "../plugins/codex/agent.ts";
import { renameThread, titleResult } from "../plugins/codex/title.ts";
import { readMessage } from "../worker/contract.ts";
import { setup } from "./helpers.ts";

const home = setup("codex-title");

test("private title metadata preserves business receipt semantics and rejects internal identifiers", () => {
  const business = '修复完成：补抓等待已正确分类\n\n```agent-autoloop\n{"later":[{"in":"5m","note":"核实"}]}\n```';
  const result = titleResult(business + "\n\n```autoloop-title\n网站补抓｜正确识别等待与失败\n```\n");
  assert.equal(result.text, business);
  assert.equal(result.title, "autoloop-网站补抓｜正确识别等待与失败");
  assert.deepEqual(readMessage(result.text), readMessage(business));
  assert.deepEqual(titleResult(business + "\n```autoloop-title\ndecision-129｜caipiao-development\n```"), {
    text: business,
    title: null,
  });
  assert.deepEqual(titleResult(business), { text: business, title: null });
});

test("a custom business program can be launched without Codex discoverable for metadata", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const {default: codex, IN_THE_APP} = await import(${JSON.stringify(new URL("../plugins/codex/agent.ts", import.meta.url).href)});
    IN_THE_APP.length = 0;
    const command = codex.command({ prompt: 'work', title: '项目｜目标', session: 'owned', resume: null,
      cwd: ${JSON.stringify(home)}, access: 'read', contextFile: '', folder: '', program: process.execPath });
    if (JSON.parse(command.at(-1)).program !== process.execPath) throw Error('business command was not constructed');
  `,
    ],
    { encoding: "utf8", env: { ...process.env, PATH: "", SHELL: "/missing-shell" } },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("naming wraps both launch paths while cancellation retains the original stop controller", () => {
  const base = {
    prompt: "finish work",
    title: "caipiao｜处理任务",
    session: "owned",
    cwd: home,
    access: "read" as const,
    contextFile: join(home, "context.json"),
    folder: home,
    program: process.execPath,
  };
  for (const resume of [null, "owned"]) {
    const command = codex.command({ ...base, resume });
    assert.ok(command[2].endsWith("resume.ts"));
    const metadata = JSON.parse(command[3]);
    assert.equal(metadata.turn.title, base.title);
    assert.equal(metadata.turn.resume, resume);
    assert.equal(metadata.program, process.execPath);
  }
  const cancel = codex.cancel!({ ...base, resume: "owned" });
  assert.ok(cancel[2].endsWith("resume.ts"));
  assert.equal(JSON.parse(cancel[3]).turn.cancel, true);
});

test("native naming prefixes a Chinese module and goal, reads it back, and is idempotent", async () => {
  let name: string | null = null;
  const calls: { method: string; params: any }[] = [];
  const rpc = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === "thread/name/set") name = params.name;
    return { thread: { id: "owned", name } };
  };
  await renameThread(rpc, "owned", "网站补抓｜修复看板同步与补抓排队");
  assert.equal(name, "autoloop-网站补抓｜修复看板同步与补抓排队");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["thread/read", "thread/name/set", "thread/read"],
  );
  assert.ok(calls.every((call) => call.params.threadId === "owned"));
  calls.length = 0;
  await renameThread(rpc, "owned", "网站补抓｜接续原任务");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["thread/read"],
  );
});

test("internal rule and worktree IDs never become titles, and a semantic name repairs the old slug", async () => {
  let name = "autoloop-decision-129｜caipiao-development-decision-129-decision-129";
  const writes: string[] = [];
  const rpc = async (method: string, params: any) => {
    if (method === "thread/name/set") writes.push((name = params.name));
    return { thread: { id: "owned", name } };
  };
  await renameThread(rpc, "owned", "autoloop-decision-129｜caipiao-development-decision-129-decision-129");
  assert.deepEqual(writes, []);
  await renameThread(rpc, "owned", "网站补抓｜正确识别等待与失败");
  assert.equal(name, "autoloop-网站补抓｜正确识别等待与失败");
  assert.equal(writes.length, 1);
});

test("empty native titles wait for semantic naming instead of copying an internal fallback", async () => {
  const methods: string[] = [];
  await renameThread(
    async (method) => {
      methods.push(method);
      return { thread: { id: "owned", name: null } };
    },
    "owned",
    "autoloop-decision-129｜caipiao-development-decision-129-decision-129",
  );
  assert.deepEqual(methods, ["thread/read"]);
});

test("an existing session keeps its title body when the origin prefix is added", async () => {
  let name = "看板同步 | 修复补抓排队";
  const rpc = async (method: string, params: any) => {
    if (method === "thread/name/set") name = params.name;
    return { thread: { id: "owned", name } };
  };
  await renameThread(rpc, "owned", "caipiao｜原规则标题");
  assert.equal(name, "autoloop-看板同步｜修复补抓排队");
});

test("metadata failure preserves the business output and exit status without running the task again", () => {
  const marker = join(home, "business-runs");
  const program = join(home, "business.cjs");
  writeFileSync(
    program,
    `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'once\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:'owned'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'业务已经完成'}}));
console.log(JSON.stringify({type:'turn.completed'}));
process.exitCode=Number(process.argv[2]);`,
  );
  const unavailable = join(home, "unavailable.cjs");
  writeFileSync(unavailable, "process.exit(2)");
  for (const code of [0, 7]) {
    const result = spawnSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        join(import.meta.dirname, "../plugins/codex/title.ts"),
        JSON.stringify({
          argv: [process.execPath, program, String(code)],
          program: unavailable,
          title: "caipiao｜处理任务",
          cwd: home,
        }),
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    assert.equal(result.status, code, result.stderr);
    assert.match(result.stdout, /业务已经完成/);
    assert.match(result.stderr, /标题/);
  }
  assert.equal(readFileSync(marker, "utf8"), "once\nonce\n");
});
