// A completed matter must not spend another model turn on old events, timers, retries or late receipts.
// Completion is an owner's explicit delivery decision, never inferred from a successful business round.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { at, setup } from "./helpers.ts";

setup("task-completion");
const { execute, ingest, claimNext, finish, tick, getView, db, stateOf, fixtureClear } = await import("./hub.ts");
const { rows } = await import("../kernel/evolve.ts");
const { rebuild } = await import("../kernel/store.ts");

const clean = () => {
  for (const table of [
    "run_events",
    "runs",
    "events",
    "cards",
    "deliveries",
    "timers",
    "schedules",
    "pauses",
    "completed",
  ] as const)
    fixtureClear(table);
};
const complete = (name: string, subject = "") =>
  execute("completeTask", [name, "owner", { subject, reason: "交付已核实" }], at(3));
const next = (worker = "w1") => claimNext(worker, `claim-${Math.random()}`, at(4));
const event = (id: string, subject = "repo-a/repair-1") => ingest("app", { id, type: "feedback.new", subject }, at(1));

test("completion retires waiting and queued work and survives rebuild, resume and repeated completion", () => {
  clean();
  event("a");
  const job = claimNext("w1", "first", at(1))!;
  finish(
    job.run,
    job.token,
    { outcome: "done", later: [{ key: "handoff", at: new Date(at(20)).toISOString(), about: "等待交付" }] },
    at(2),
  );
  event("queued");
  complete("意见", "repo-a/repair-1");
  assert.equal(rows(getView(), "timers").length, 0);
  assert.equal(rows(getView(), "runs", { state: "queued" }).length, 0);
  const seq = getView().seq;
  assert.equal(complete("意见", "repo-a/repair-1").changed, false);
  assert.equal(getView().seq, seq, "lost responses do not create a second completion");
  rebuild(db);
  execute("resumeRule", ["意见"], at(4));
  assert.deepEqual(event("late-event").routed, []);
  assert.deepEqual(event("late-event").routed, [], "duplicate acknowledgments report the same suppressed routing");
  tick(at(21));
  assert.equal(next(), null, "neither an old timer nor a new ID for the old matter invokes a worker");
  assert.equal(stateOf(at(22)).completed.length, 1);
  assert.throws(() => execute("runRule", ["意见", "owner", { subject: "repo-a/repair-1" }], at(22)), /已完成/);
});

test("completion is exact to a matter; other projects and recurring business still run", () => {
  clean();
  complete("意见", "repo-a/repair-1");
  event("closed");
  event("other-repair", "repo-b/repair-1");
  assert.equal(next()!.context.events[0].subject, "repo-b/repair-1");
  tick(at(0));
  tick(at(5));
  const business = claimNext("w1", "business", at(6))!;
  assert.equal(business.rule.name, "巡检");
  finish(business.run, business.token, { outcome: "done" }, at(6));
  tick(at(10));
  assert.equal(claimNext("w1", "business-again", at(11))!.rule.name, "巡检");
  assert.throws(() => complete("巡检"), /定时/);
  assert.throws(() => complete("意见"), /subject/);
});

test("late failure or success after completion cannot create retries, followups or events", () => {
  for (const outcome of ["done", "failed"]) {
    clean();
    event(`active-${outcome}`);
    const job = next()!;
    complete("意见", "repo-a/repair-1");
    execute("reopenTask", ["意见", "owner", { subject: "repo-a/repair-1", reason: "新需求" }], at(5));
    finish(
      job.run,
      job.token,
      { outcome, later: [{ key: "stale", at: new Date(at(8)).toISOString(), about: "旧复查" }] },
      at(6),
    );
    assert.equal(rows(getView(), "timers").length, 0, "an old execution stays retired even after explicit reopening");
    assert.equal(rows(getView(), "runs", { state: "queued" }).length, 0);
    event("new-work");
    assert.ok(claimNext("w1", "reopened", at(7)), "an explicit owner decision allows new work");
  }
});

test("a successful ordinary event round is not task completion, and unresolved questions block completion", () => {
  clean();
  event("business-1");
  const first = next()!;
  finish(first.run, first.token, { outcome: "done" }, at(2));
  event("business-2");
  const second = next()!;
  finish(
    second.run,
    second.token,
    {
      outcome: "done",
      ask: [{ title: "仍需选择", text: "请决定是否继续", options: ["继续", "暂缓"], recommend: 0, about: "未交付" }],
    },
    at(2),
  );
  assert.throws(() => complete("意见", "repo-a/repair-1"), /提问/);
  assert.equal(rows(getView(), "completed").length, 0);
});

test("the shared completion and reopening doors require an owner key and validate exact scope", async () => {
  clean();
  const { serve } = await import("../host/http.ts");
  const { addKey } = await import("./hub.ts");
  const { hubClient, HubError } = await import("../protocol/client.ts");
  const server = serve(0, "127.0.0.1", { commit: "task-test" });
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}`;
    for (const kind of ["source", "worker", "channel"] as const) {
      const client = hubClient(url, addKey(kind, kind === "worker" ? "w1" : kind === "channel" ? "chat" : "app"));
      await assert.rejects(
        client.complete("意见", { subject: "one", reason: "done" }),
        (error: unknown) => error instanceof HubError && error.status === 401,
      );
    }
    const owner = hubClient(url, addKey("owner", "owner"));
    await assert.rejects(owner.complete("意见", { reason: "missing scope" }), /subject/);
    await assert.rejects(owner.complete("巡检", { reason: "not a task" }), /定时/);
    assert.equal((await owner.complete("意见", { subject: "one", reason: "交付读回已核实" })).changed, true);
    assert.equal((await owner.state()).completed.length, 1);
    assert.equal((await owner.reopen("意见", { subject: "one", reason: "新的有效决定" })).changed, true);
    assert.equal((await owner.state()).completed.length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a lost claim response cannot hand out completed work again", () => {
  clean();
  event("lost-response");
  const job = claimNext("w1", "lost-claim", at(1))!;
  assert.ok(job);
  complete("意见", "repo-a/repair-1");
  assert.equal(claimNext("w1", "lost-claim", at(4)), null);
});

test("completing a delivery still settles the question that resumed its current execution", () => {
  clean();
  event("question");
  const first = next()!;
  finish(
    first.run,
    first.token,
    {
      outcome: "done",
      ask: [{ title: "按方案修复", text: "选择后继续", options: ["修复", "取消"], recommend: 0, about: "原范围" }],
    },
    at(2),
  );
  const card = rows(getView(), "cards")[0];
  execute("answer", [card.id, { choice: 0, by: "owner" }], at(3));
  const resumed = next()!;
  complete("意见", "repo-a/repair-1");
  finish(resumed.run, resumed.token, { outcome: "done", summary: "交付已核实" }, at(5));
  assert.equal(getView().get("cards", card.id)!.state, "done");
  assert.equal(getView().get("cards", card.id)!.result, "交付已核实");
});

test("independent fact replay covers completion, suppressed events, reopening and late results", async () => {
  const { decide } = await import("../kernel/decide.ts");
  const { empty, evolve } = await import("../kernel/evolve.ts");
  const { invariants } = await import("../sim/invariants.ts");
  const { parseRules } = await import("../protocol/rules.ts");
  const rules = parseRules(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"), at(0), "UTC");
  for (const outcome of ["done", "failed"]) {
    let current = empty();
    const log: import("../kernel/evolve.ts").Fact[] = [];
    let previous: ReturnType<typeof invariants> | undefined;
    let time = at(0);
    const act = (type: string, ...args: any[]) => {
      const decision = decide(current, { type, args }, time++, { secret: "completion", publicUrl: "https://hub.test" });
      log.push(...decision.facts);
      current = evolve(current, decision.facts);
      previous = invariants(current, log, previous);
      return decision.value;
    };
    try {
      act("rules", rules);
      act("ingest", "app", { id: "first", type: "feedback.new", subject: "task-a" });
      const job = act("claimNext", "w1", "first");
      act("completeTask", "意见", "owner", { subject: "task-a", reason: "交付已核实" });
      act("ingest", "app", { id: "old", type: "feedback.new", subject: "task-a" });
      act("ingest", "app", { id: "other", type: "feedback.new", subject: "task-b" });
      act("reopenTask", "意见", "owner", { subject: "task-a", reason: "新工作" });
      act("finish", job.run, job.token, { outcome, summary: "迟到结果" });
      act("finish", job.run, job.token, { outcome, summary: "迟到结果" });
    } finally {
      current.close();
    }
  }
});
