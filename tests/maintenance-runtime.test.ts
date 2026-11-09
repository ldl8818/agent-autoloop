// Failure modes: native adapters lose stage sessions, retries re-run an already completed phase, author output goes
// straight to the hub as instructions, or a lost coordinator response loses the next dispatch.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";
import { readMessage } from "../worker/contract.ts";
import maintenance from "../plugins/maintenance/agent.ts";
import { rules } from "../plugins/maintenance/flow.ts";

const home = setup("maintenance-runtime");
mkdirSync(join(home, "plugins/maintenance"), { recursive: true });
for (const file of ["agent.ts", "flow.ts", "run.ts"])
  copyFileSync(join(import.meta.dirname, "../plugins/maintenance", file), join(home, "plugins/maintenance", file));
const engine = join(import.meta.dirname, "../plugins/maintenance/run.ts");
const cli = join(home, "model.mjs");
const hook = join(home, "hook.mjs");
const calls = join(home, "model-calls.jsonl");
writeFileSync(
  cli,
  `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const prompt=process.argv.at(-1), session=process.argv.includes('resume')?process.argv.at(-2):randomUUID();
const role=prompt.includes('规划员')?'plan':prompt.includes('独立验收员')?'verify':'execute';
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({role,session,args:process.argv.slice(2)})+'\\n');
for(const value of [{type:'thread.started',thread_id:session},{type:'turn.started'},
{type:'item.completed',item:{type:'agent_message',text:role==='plan'?JSON.stringify({title:'修复',steps:'修正源码',impact:'仅测试项目',rollback:'保留原提交',acceptance:'独立证据通过'}):role==='verify'?JSON.stringify({ok:true,summary:'独立检查通过'}):'已修改源码'}},
{type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}]) console.log(JSON.stringify(value));
`,
);
chmodSync(cli, 0o700);
const recoveryFile = join(home, "recovered-fixture");
writeFileSync(
  hook,
  `import {readFileSync,appendFileSync,existsSync} from 'node:fs';
const {stage,task}=JSON.parse(readFileSync(0,'utf8'));
appendFileSync(${JSON.stringify(join(home, "hook-calls"))},stage+'\\n');
const recovered=existsSync(${JSON.stringify(recoveryFile)})&&readFileSync(${JSON.stringify(recoveryFile)},'utf8')===task.incident?.id;
const blocked=existsSync(${JSON.stringify(recoveryFile)})&&readFileSync(${JSON.stringify(recoveryFile)},'utf8')==='blocked:'+task.incident?.id;
console.log(JSON.stringify(stage==='executed' && task.incident?.resumeFixture && !task.attempts?.execute?{ok:false,resumable:true,summary:'审查待修'}:stage==='status' && task.incident?.unknown?{ok:false,summary:'操作结果未知'}:stage==='inspect'?{status:recovered?'resolved':blocked?'blocked':'active',facts:{issue:'broken'}}:{ok:true,summary:'可信检查通过'}));`,
);
const config = join(home, "settings.json");
writeFileSync(
  config,
  JSON.stringify({
    id: "sample",
    root: home,
    state: join(home, "state"),
    worker: "test",
    when: { source: "business", types: ["failed"] },
    hook: [process.execPath, hook],
    roles: Object.fromEntries(
      ["plan", "execute", "verify"].map((role) => [
        role,
        { use: "codex", access: role === "execute" ? "edit" : "read", program: cli },
      ]),
    ),
  }),
);

function invoke(mode: string, context: any, round: number) {
  const folder = join(home, "rounds", String(round));
  mkdirSync(folder, { recursive: true });
  const contextFile = join(folder, "context.json");
  writeFileSync(contextFile, JSON.stringify(context));
  const stdout = execFileSync(
    process.execPath,
    [engine, config, mode, JSON.stringify({ folder, contextFile, session: crypto.randomUUID(), resume: null })],
    { env: { ...process.env, AGENT_AUTOLOOP_RUN: String(round) }, encoding: "utf8" },
  );
  const reading = maintenance.read(stdout, 0, "");
  assert.equal(reading.error, undefined);
  return readMessage(reading.text!).receipt as any;
}
const context = (events: any[] = [], answers: any[] = []) => ({ events, answers, timers: [], waiting: [], open: [] });
test("real native stage processes isolate three sessions and persist replayable coordinator receipts", () => {
  const first = invoke(
    "coordinate",
    context([{ source: "business", type: "failed", id: "failure-1", subject: "job-1" }]),
    1,
  );
  assert.deepEqual(
    invoke("coordinate", context([{ source: "business", type: "failed", id: "failure-1", subject: "job-1" }]), 1),
    first,
  );
  const event = (e: any) => ({ ...e, source: "maintenance-sample" });
  const planned = invoke("plan", context(first.events.map(event)), 2);
  assert.deepEqual(invoke("plan", context(first.events.map(event)), 2), planned);
  const ask = planned.ask[0];
  const approval = { ...ask, card: 9, by: "owner", at: "2026-11-10T00:00:00+08:00", choice: 0 };
  const execution = invoke("coordinate", context([], [approval]), 4);
  const verification = invoke("execute", context(execution.events.map(event)), 5);
  const finish = invoke("verify", context(verification.events.map(event)), 7);
  assert.match(finish.notice[0].text, /可信检查通过/);
  const runs = readFileSync(calls, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    runs.map((run) => run.role),
    ["plan", "execute", "verify"],
  );
  assert.equal(new Set(runs.map((run) => run.session)).size, 3);
  assert.ok(runs.every((run) => !run.args.includes("resume")));
  const tasks = JSON.parse(readFileSync(join(home, "state/flow.json"), "utf8")).tasks as Record<string, any>;
  assert.equal(Object.values(tasks)[0].status, "done");
});

test("a started execution with no result is read back and never launches the command again", () => {
  const id = "f".repeat(32),
    state = join(home, "state/flow.json");
  const database = JSON.parse(readFileSync(state, "utf8"));
  database.tasks[id] = { id, revision: 1, status: "executing", incident: { unknown: true } };
  writeFileSync(state, JSON.stringify(database));
  mkdirSync(join(home, "state", id), { recursive: true });
  writeFileSync(join(home, "state", id, "1-execute-0-started.json"), JSON.stringify({ session: "previous-session" }));
  const before = readFileSync(calls, "utf8");
  const out = invoke(
    "execute",
    context([{ source: "maintenance-sample", type: "maintenance.execute", subject: id, detail: '{"revision":1}' }]),
    99,
  );
  assert.match(out.ask[0].text, /未重复执行/);
  assert.equal(readFileSync(calls, "utf8"), before);
  assert.equal(JSON.parse(readFileSync(state, "utf8")).tasks[id].status, "blocked");
});

test("the real worker and kernel carry approval through all stages without duplicate dispatch", async () => {
  const second = {
    ...JSON.parse(readFileSync(config, "utf8")),
    id: "worker",
    recovered: ["recovered"],
    state: join(home, "worker-state"),
  };
  const configFile = join(home, "worker-settings.json");
  writeFileSync(configFile, JSON.stringify(second));
  const fragment = rules(second, configFile);
  const producer = join(home, "producer.mjs");
  writeFileSync(
    producer,
    `console.log('生产者已返回。\\n\`\`\`agent-autoloop\\n'+JSON.stringify({events:[{id:'failure-from-producer',type:'failed',subject:'job-2',summary:'原业务失败'}]})+'\\n\`\`\`')`,
  );
  fragment.agents.producer = {
    name: "原业务程序",
    worker: "test",
    use: "command",
    command: [process.execPath, producer],
    access: "read",
  };
  fragment.rules.push({
    name: "producer",
    to: "producer",
    cwd: home,
    group: "producer",
    parallel: 1,
    resume: false,
    tell: "needed",
    prompt: "固定业务程序",
    when: { source: "business", types: ["start"] },
    emits: { source: "business", types: ["failed"] },
  });
  const ruleFile = join(home, "worker-rules.json");
  writeFileSync(
    ruleFile,
    JSON.stringify({ ...fragment, sources: { ...fragment.sources, business: { name: "业务" } } }),
  );
  process.env.AGENT_AUTOLOOP_RULES = ruleFile;
  const hub = await import("./hub.ts");
  const { createWorker } = await import("../worker/worker.ts");
  hub.addKey("worker", "test");
  const results: any[] = [];
  const transport = {
    work: async (query: any) => ({ job: query.capacity ? hub.claimNext("test", query.claim) : null, cancel: [] }),
    started: async (run: number, token: string, body: any) => hub.started(run, token, body),
    result: async (run: number, token: string, body: any) => {
      results.push(body);
      return hub.finish(run, token, body);
    },
  };
  const worker = createWorker({ hub: transport as any, name: "test", wait: 0, capacity: 1 });
  const pump = async (done: () => boolean) => {
    const until = Date.now() + 15000;
    while (!done()) {
      assert.ok(Date.now() < until, JSON.stringify({ state: hub.stateOf(), results }));
      await worker.tick();
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  };
  const event = { id: "failure-2", type: "start", subject: "job-2" };
  hub.ingest("business", event);
  await pump(() => hub.stateOf().cards.some((card: any) => card.state === "open"));
  const firstCard: any = hub.stateOf().cards.find((item: any) => item.state === "open");
  hub.answer(firstCard.id, { text: "先明确修复范围，再执行", by: "owner" });
  await pump(() => hub.stateOf().cards.some((item: any) => item.state === "open" && item.id !== firstCard.id));
  const card: any = hub.stateOf().cards.find((item: any) => item.state === "open" && item.id !== firstCard.id);
  hub.answer(card.id, { choice: 0, by: "owner" });
  assert.equal(hub.answer(card.id, { choice: 0, by: "owner" }).changed, false);
  assert.equal(hub.ingest("business", event).duplicate, true);
  await pump(
    () =>
      existsSync(join(home, "worker-state/flow.json")) &&
      Object.values(
        JSON.parse(readFileSync(join(home, "worker-state/flow.json"), "utf8")).tasks as Record<string, any>,
      ).some((task) => task.status === "done"),
  );
  await pump(() => hub.stateOf().runs.every((run: any) => !["running", "queued"].includes(run.state)));
  assert.ok(
    results.every((result) => result.outcome === "done"),
    JSON.stringify(results),
  );
  const modelRuns = readFileSync(calls, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(modelRuns.filter((run: any) => run.role === "execute").length, 2);
  hub.ingest("business", { id: "failure-3", type: "failed", subject: "job-3" });
  hub.ingest("business", { id: "failure-4", type: "failed", subject: "job-3" });
  await pump(() => hub.stateOf().cards.filter((item: any) => item.state === "open").length === 2);
  const tasks = Object.values(JSON.parse(readFileSync(join(home, "worker-state/flow.json"), "utf8")).tasks) as any[];
  const recoveredTask = tasks.find((task) => task.incident.id === "failure-3");
  const remainingTask = tasks.find((task) => task.incident.id === "failure-4");
  writeFileSync(recoveryFile, "failure-3");
  hub.ingest("business", { id: "recover-3", type: "recovered", subject: "job-3" });
  await pump(() => hub.stateOf().cards.filter((item: any) => item.state === "open").length === 1);
  const remaining: any = hub.stateOf().cards.find((item: any) => item.state === "open");
  assert.match(remaining.text, new RegExp(remainingTask.id));
  assert.ok(!remaining.text.includes(recoveredTask.id));
  writeFileSync(recoveryFile, "blocked:failure-5");
  hub.ingest("business", { id: "failure-5", type: "failed", subject: "job-5" });
  await pump(() => hub.stateOf().cards.filter((item: any) => item.state === "open").length === 2);
  const blockedCard: any = hub.stateOf().cards.find((item: any) => item.state === "open" && item.id !== remaining.id);
  assert.ok(blockedCard.rule.endsWith("-plan"));
  writeFileSync(recoveryFile, "failure-5");
  hub.ingest("business", { id: "recover-5", type: "recovered", subject: "job-5" });
  await pump(() => hub.stateOf().cards.filter((item: any) => item.state === "open").length === 1);
  assert.equal(hub.stateOf().cards.find((item: any) => item.state === "open")!.id, remaining.id);
  await pump(() => worker.entries().length === 0);
});

test("an explicitly resumed repair invokes the original native session and retains its candidate", () => {
  const id = "e".repeat(32),
    state = join(home, "state/flow.json");
  const database = JSON.parse(readFileSync(state, "utf8"));
  const prepared = { cwd: home, worktree: "retained-candidate" };
  database.tasks[id] = {
    id,
    revision: 1,
    status: "executing",
    incident: { resumeFixture: true },
    prepared,
    approved: { card: 11, by: "owner" },
    plan: {
      title: "修复",
      steps: "修正源码",
      impact: "仅测试项目",
      rollback: "保留原提交",
      acceptance: "独立证据通过",
    },
  };
  writeFileSync(state, JSON.stringify(database));
  const first = invoke(
    "execute",
    context([{ source: "maintenance-sample", type: "maintenance.execute", subject: id, detail: '{"revision":1}' }]),
    100,
  );
  const ask = first.ask[0];
  assert.equal(ask.options[0], "继续本阶段");
  const retry = invoke("execute", context([], [{ ...ask, card: 12, by: "owner", choice: 0 }]), 101);
  invoke("execute", context(retry.events.map((event: any) => ({ ...event, source: "maintenance-sample" }))), 102);
  const callsAfter = readFileSync(calls, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .slice(-2);
  assert.ok(!callsAfter[0].args.includes("resume"));
  assert.ok(callsAfter[1].args.includes("resume"));
  assert.equal(callsAfter[0].session, callsAfter[1].session);
  assert.deepEqual(JSON.parse(readFileSync(state, "utf8")).tasks[id].prepared, prepared);
});
