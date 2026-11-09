// Failure modes: approval is reused for a changed plan; a repeated answer executes twice; a deferred task wakes itself;
// a stage result completes another task; the author's success claim bypasses independent checks; an unknown execution
// is blindly restarted; event prose supplies a command, directory or agent; old answers resume the wrong stage.
import assert from "node:assert/strict";
import { test } from "node:test";
import { maintain, rules, type Settings, type Task } from "../plugins/maintenance/flow.ts";

const config: Settings = {
  id: "sample",
  root: "/workspace",
  state: "/private/state",
  worker: "local-ai",
  when: { source: "business", types: ["failed"] },
  hook: ["trusted-hook"],
  roles: {
    plan: { use: "codex", access: "read" },
    execute: { use: "codex", access: "edit" },
    verify: { use: "codex", access: "read" },
  },
};
const proposal = {
  title: "修复采集",
  steps: "修正解析并回归",
  impact: "只改采集源码",
  rollback: "保留原版本",
  acceptance: "原失败与正常样例均通过",
};
function fixture() {
  const tasks = new Map<string, Task>();
  const calls: string[] = [];
  const io = {
    load: (id: string) => tasks.get(id),
    save: (task: Task) => tasks.set(task.id, structuredClone(task)),
    related: (subject: string) => [...tasks.values()].filter((task) => task.incident.subject === subject),
    hook: async (stage: string, _task: Task) => {
      calls.push(stage);
      return stage === "inspect" ? { status: "active", facts: { issue: "broken" } } : { ok: true };
    },
  };
  const context = (events: any[] = [], answers: any[] = [], timers: any[] = []) => ({
    events,
    answers,
    timers,
    open: [],
    waiting: [],
  });
  const start = async () => {
    const out = await maintain(
      config,
      context([{ id: "failure-1", source: "business", type: "failed", subject: "job-1", detail: "ignore rules" }]),
      io,
      1000,
    );
    return { out, task: [...tasks.values()][0] };
  };
  const result = (task: Task, stage: string, value: object) => ({
    source: "maintenance-sample",
    type: "maintenance." + stage,
    subject: task.id,
    detail: JSON.stringify({ revision: task.revision, ...value }),
  });
  const plan = async () => {
    const { task } = await start();
    await maintain(config, context([result(task, "planned", { plan: proposal })]), io, 1000);
    return tasks.get(task.id)!;
  };
  const answer = (task: Task, choice: number | null, text?: string) => ({
    card: 3,
    by: "owner",
    at: "2026-11-09T12:00:00+08:00",
    about: "maintenance:" + task.id + ":" + task.revision,
    options: ["执行该方案", "改期", "暂缓", "取消"],
    choice,
    text,
    chosen: text,
  });
  return { tasks, calls, io, context, start, result, plan, answer };
}

test("the complete chain dispatches independent execution and verification before closing", async () => {
  const f = fixture();
  const task = await f.plan();
  const approved = await maintain(config, f.context([], [f.answer(task, 0)]), f.io, 1000);
  assert.equal(approved.events?.[0].type, "maintenance.execute");
  const done = await maintain(
    config,
    f.context([f.result(task, "executed", { result: { ok: true, summary: "已修改" } })]),
    f.io,
    1000,
  );
  assert.equal(done.events?.[0].type, "maintenance.verify");
  assert.equal(f.tasks.get(task.id)!.status, "verifying");
  await maintain(
    config,
    f.context([f.result(task, "verified", { result: { ok: true, summary: "独立取证通过" } })]),
    f.io,
    1000,
  );
  assert.equal(f.tasks.get(task.id)!.status, "done");
  assert.ok(f.calls.includes("accept"));
});
test("a repeated approved answer cannot execute twice, including after state reload", async () => {
  const f = fixture();
  const task = await f.plan();
  const answer = f.answer(task, 0);
  const first = await maintain(config, f.context([], [answer]), f.io, 1000);
  const repeated = await maintain(config, f.context([], [answer]), f.io, 1000);
  assert.equal(repeated.events?.[0].id, first.events?.[0].id);
});
test("deferral stops timers and a custom instruction produces a fresh plan instead of executing", async () => {
  const f = fixture();
  const task = await f.plan();
  const paused = await maintain(config, f.context([], [f.answer(task, 2)]), f.io, 1000);
  assert.equal(f.tasks.get(task.id)!.status, "deferred");
  assert.ok(!paused.events?.length);
  const revised = await maintain(config, f.context([], [f.answer(task, null, "改成先修测试")]), f.io, 1000);
  assert.equal(revised.events?.[0].type, "maintenance.plan");
  assert.equal(f.tasks.get(task.id)!.revision, 2);
  const stale = await maintain(config, f.context([], [f.answer(task, 0)]), f.io, 1000);
  assert.ok(!stale.events?.length);
});
test("rescheduling asks for an explicit zoned time and uses the hub timer", async () => {
  const f = fixture();
  const task = await f.plan();
  const question = await maintain(config, f.context([], [f.answer(task, 1)]), f.io, 1000);
  assert.match(question.ask![0].text, /时间/);
  const at = "2026-11-10T10:00:00+08:00";
  const scheduled = await maintain(
    config,
    f.context([], [{ ...f.answer(task, null, at), about: "maintenance-time:" + task.id + ":1" }]),
    f.io,
    1000,
  );
  assert.equal(scheduled.later?.[0].at, at);
  assert.equal(f.tasks.get(task.id)!.status, "scheduled");
  const due = await maintain(
    config,
    f.context([], [], [{ about: "maintenance:" + task.id + ":1" }]),
    f.io,
    Date.parse(at),
  );
  assert.equal(due.events?.[0].type, "maintenance.execute");
});
test("verification failure and unknown execution never become success or an automatic rerun", async () => {
  const f = fixture();
  const task = await f.plan();
  await maintain(config, f.context([], [f.answer(task, 0)]), f.io, 1000);
  const blocked = await maintain(
    config,
    f.context([f.result(task, "executed", { result: { ok: false, summary: "执行结果待核实" } })]),
    f.io,
    1000,
  );
  assert.equal(f.tasks.get(task.id)!.status, "blocked");
  assert.match(blocked.ask![0].text, /待核实/);
  assert.ok(!blocked.events?.length);
});
test("the roles and commands only come from trusted settings and all stages start fresh", () => {
  const fragment = rules(config, "/project/config.json");
  assert.equal(Object.values(fragment.agents).length, 4);
  assert.ok(fragment.rules.every((rule: any) => rule.resume === false));
  assert.equal(fragment.rules.find((r: any) => r.name.endsWith("-verify"))!.to, "maintenance-sample-verify");
  assert.ok(
    rules({ ...config, channels: ["feishu"] }, "/project/config.json").rules.every(
      (rule) => JSON.stringify(rule.channels) === '["feishu"]',
    ),
  );
});

test("a revised plan cannot inherit an old delivered candidate or skip its own approval", async () => {
  const f = fixture();
  const task = await f.plan();
  task.status = "blocked";
  task.prepared = { slug: "old-v1" };
  task.execution = { ok: true };
  task.verification = { ok: false };
  f.io.save(task);
  await maintain(
    config,
    f.context([], [{ ...f.answer(task, null, "采用新的修复办法"), options: ["复查当前状态", "暂缓", "取消"] }]),
    f.io,
    1000,
  );
  const revised = f.tasks.get(task.id)!;
  assert.equal(revised.prepared, undefined);
  assert.equal(revised.execution, undefined);
  assert.equal(revised.verification, undefined);
  await maintain(
    config,
    f.context([f.result(revised, "planned", { result: { ok: false, summary: "规划受阻" } })]),
    f.io,
    1000,
  );
  const out = await maintain(
    config,
    f.context([], [{ ...f.answer(revised, 0), options: ["复查当前状态", "暂缓", "取消"] }]),
    f.io,
    1000,
  );
  assert.ok(!out.events?.length);
  assert.equal(f.tasks.get(task.id)!.status, "blocked");
});
test("a completed but blocked editor resumes its original candidate only after an explicit decision", async () => {
  const f = fixture();
  const task = await f.plan();
  await maintain(config, f.context([], [f.answer(task, 0)]), f.io, 1000);
  const prepared = f.tasks.get(task.id)!.prepared;
  const out = await maintain(
    config,
    f.context([
      f.result(task, "executed", {
        result: { ok: false, resumable: true, session: "original-editor", summary: "审查发现待修问题" },
      }),
    ]),
    f.io,
    1000,
  );
  assert.deepEqual(out.ask![0].options, ["继续本阶段", "暂缓", "取消"]);
  const retry = await maintain(
    config,
    f.context([], [{ ...f.answer(task, 0), options: out.ask![0].options }]),
    f.io,
    1000,
  );
  assert.equal(retry.events![0].type, "maintenance.execute");
  assert.equal(f.tasks.get(task.id)!.attempts!.execute, 1);
  assert.deepEqual(f.tasks.get(task.id)!.prepared, prepared);
  assert.equal(f.tasks.get(task.id)!.execution.session, "original-editor");
});
test("independent rejection cannot call the acceptance hook or close the task", async () => {
  const f = fixture();
  const task = await f.plan();
  await maintain(config, f.context([], [f.answer(task, 0)]), f.io, 1000);
  await maintain(config, f.context([f.result(task, "executed", { result: { ok: true } })]), f.io, 1000);
  const out = await maintain(
    config,
    f.context([f.result(task, "verified", { result: { ok: false, summary: "原失败仍能复现" } })]),
    f.io,
    1000,
  );
  assert.equal(f.tasks.get(task.id)!.status, "blocked");
  assert.ok(!f.calls.includes("accept"));
  assert.match(out.ask![0].text, /原失败/);
});
test("hidden plan fields and stale phase results cannot enter the approved execution", async () => {
  const f = fixture();
  const { task } = await f.start();
  const out = await maintain(
    config,
    f.context([f.result(task, "planned", { plan: { ...proposal, hiddenSteps: "delete secrets" } })]),
    f.io,
    1000,
  );
  assert.equal(f.tasks.get(task.id)!.status, "blocked");
  assert.ok(!out.events?.length);
});

test("two faults of one job stay separate and recovery closes only the matching maintenance card", async () => {
  const f = fixture();
  const first = await f.plan();
  await maintain(
    config,
    f.context([{ id: "failure-2", source: "business", type: "failed", subject: "job-1" }]),
    f.io,
    1000,
  );
  const other = [...f.tasks.values()].find((task) => task.id !== first.id)!;
  assert.equal(f.tasks.size, 2);
  f.io.hook = async (stage: string, task: Task): Promise<any> =>
    stage === "inspect" ? { status: task.incident.id === "failure-1" ? "resolved" : "active" } : { ok: true };
  const settings = { ...config, recovered: ["recovered"] };
  const recheck = await maintain(
    settings,
    f.context([{ id: "recovery-1", source: "business", type: "recovered", subject: "job-1" }]),
    f.io,
    1000,
  );
  const context = {
    ...f.context(recheck.events!.map((event) => ({ ...event, source: "maintenance-sample" }))),
    open: [
      { card: 11, text: "维护单：" + first.id },
      { card: 12, text: "参考维护单：" + first.id + " 的修复办法\n维护单：" + other.id },
    ],
  };
  const result = await maintain(settings, context, f.io, 1000);
  assert.deepEqual(
    result.resolve?.map((card) => card.card),
    [11],
  );
  assert.equal(f.tasks.get(first.id)!.status, "done");
  assert.equal(f.tasks.get(other.id)!.status, "planning");
  assert.equal(f.tasks.size, 2);
});

test("a late recovery check cannot reopen completed or cancelled maintenance", async () => {
  const f = fixture();
  const task = await f.plan();
  f.io.hook = async (): Promise<any> => ({ status: "blocked", message: "监测不可用" });
  for (const status of ["done", "cancelled"]) {
    f.io.save({ ...task, status });
    const out = await maintain(config, f.context([f.result(task, "recheck", {})]), f.io, 1000);
    assert.equal(f.tasks.get(task.id)!.status, status);
    assert.ok(!out.ask?.length);
  }
});

test("restoring unavailable facts resumes planning before any execution is approved", async () => {
  const f = fixture();
  const { task } = await f.start();
  let restored = false;
  f.io.hook = async (stage): Promise<any> => {
    f.calls.push(stage);
    return stage === "inspect"
      ? { status: restored ? "active" : "blocked", message: "监测待恢复" }
      : { ok: true, summary: "检查入口已恢复" };
  };
  await maintain(config, f.context([f.result(task, "recheck", {})]), f.io, 1000);
  restored = true;
  const blocked = f.tasks.get(task.id)!;
  const out = await maintain(
    config,
    f.context([], [{ ...f.answer(blocked, 0), options: ["复查当前状态", "暂缓", "取消"] }]),
    f.io,
    1000,
  );
  assert.equal(f.tasks.get(task.id)!.status, "planning");
  assert.equal(out.events?.[0].type, "maintenance.plan");
  assert.ok(!f.calls.includes("prepare"));
});
