// A verified one-off delivery closes through pause/cancel/later, without adding a task state machine.
// Preserve ordinary failures, recurring business, other projects and already-written completion facts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, evolve, rows, snapshot, type Fact } from "../kernel/evolve.ts";
import { parseRules } from "../protocol/rules.ts";

const fixture = JSON.parse(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"));
const rules = parseRules(
  JSON.stringify({
    ...fixture,
    rules: [
      ...fixture.rules,
      ...["repair-alpha", "repair-beta"].map((name) => ({
        name,
        when: { source: "app", types: ["repair.ready"] },
        to: "a2",
        cwd: "/offline",
        prompt: "verified task",
      })),
    ],
  }),
  0,
  "UTC",
);
function hub() {
  let view = empty();
  let now = Date.parse("2026-10-18T02:00:00Z");
  const log: Fact[] = [];
  const act = (type: string, ...args: any[]) => {
    const d = decide(view, { type, args }, now, { secret: "offline", publicUrl: "https://hub.test" });
    log.push(...d.facts);
    view = evolve(view, d.facts);
    return d.value;
  };
  act("rules", rules);
  return {
    act,
    view: () => view,
    advance: (minutes: number) => {
      now += minutes * 60_000;
    },
    replay: () => {
      const old = view;
      view = evolve(empty(), log);
      old.close();
    },
    close: () => view.close(),
    legacy: (fact: Fact) => {
      log.push(fact);
      view = evolve(view, [fact]);
    },
  };
}

test("old handoff timer and queued rounds are removed by an ordinary final receipt and owner controls", () => {
  const h = hub();
  try {
    h.act("ingest", "ops", { id: "first", type: "alert.raised" });
    const first = h.act("claimNext", "w2", "first");
    h.act("finish", first.run, first.token, {
      outcome: "done",
      later: [{ key: "handoff", at: "2026-10-18T03:00:00Z", about: "等待交接" }],
    });
    h.act("ingest", "ops", { id: "delivery", type: "alert.raised" });
    const delivery = h.act("claimNext", "w2", "delivery");
    h.act("ingest", "ops", { id: "queued", type: "alert.raised" });
    h.act("pauseRule", "告警", "owner", { reason: "交付已核实" });
    for (const run of rows(h.view(), "runs", { rule: "告警", state: "queued" })) h.act("cancel", run.id);
    h.act("finish", delivery.run, delivery.token, { outcome: "done", later: [{ key: "handoff", cancel: true }] });
    assert.equal(rows(h.view(), "timers", { rule: "告警" }).length, 0);
    h.replay();
    h.act("ingest", "ops", { id: "stale", type: "alert.raised" });
    h.advance(120);
    h.act("tick");
    assert.equal(h.act("claimNext", "w2", "late"), null);
    assert.equal(rows(h.view(), "runs", { rule: "告警", state: "queued" }).length, 0);
    assert.ok(h.act("claimNext", "w1", "other"), "another consumer and scheduled business still run");
  } finally {
    h.close();
  }
});

test("retiring one project's independent rule does not retire another project's rule", () => {
  const h = hub();
  try {
    h.act("pauseRule", "repair-alpha", "owner", { reason: "verified delivery" });
    const ack = h.act("ingest", "app", { id: "new", type: "repair.ready" });
    assert.deepEqual(ack.routed, ["repair-beta"]);
    assert.equal(h.act("claimNext", "w2", "beta").rule.name, "repair-beta");
  } finally {
    h.close();
  }
});

test("real failures retry and successful recurring business is not retired", () => {
  const h = hub();
  try {
    h.act("ingest", "ops", { id: "fail", type: "alert.raised" });
    const job = h.act("claimNext", "w2", "fail");
    h.act("finish", job.run, job.token, { outcome: "failed", error: "network failure" });
    assert.equal(h.view().get("runs", job.run)!.state, "queued");
    assert.equal(rows(h.view(), "pauses").length, 0);
    h.act("tick");
    h.advance(5);
    h.act("tick");
    const business = h.act("claimNext", "w1", "business");
    // An ordinary event consumer may come first; finish it before claiming the scheduled command.
    h.act("finish", business.run, business.token, { outcome: "done" });
    const scheduled = h.act("claimNext", "w1", "scheduled");
    assert.equal(scheduled.rule.name, "巡检");
    h.act("finish", scheduled.run, scheduled.token, { outcome: "done" });
    h.advance(5);
    h.act("tick");
    assert.equal(h.act("claimNext", "w1", "next-business").rule.name, "巡检");
  } finally {
    h.close();
  }
});

test("legacy completed records remain readable and replayable without active complete or reopen commands", () => {
  const h = hub();
  try {
    const key = JSON.stringify(["repair-alpha", ""]);
    const row = {
      rule: "repair-alpha",
      lane: "",
      state: "done",
      reason: "historical delivery",
      by: "owner",
      at: "2026-10-18T02:00:00Z",
    };
    h.legacy({
      version: 1,
      seq: h.view().seq + 1,
      at: Date.parse(row.at),
      type: "completeTask",
      changes: [{ table: "completed", key, row }],
    });
    h.act("pauseRule", "repair-alpha", "owner", { reason: "verified delivery" });
    const before = snapshot(h.view());
    h.replay();
    assert.deepEqual(snapshot(h.view()), before);
    assert.deepEqual(h.view().get("completed", key), row);
    for (const method of ["completeTask", "reopenTask"])
      assert.throws(() => h.act(method, "repair-alpha", "owner", { reason: "not supported" }), /不认识的输入/);
  } finally {
    h.close();
  }
});
