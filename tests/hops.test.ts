// Failure modes: emitted loops reset their depth; answers and deferred work discard the chain; a blocked event disappears
// or is dispatched anyway; malformed depth crosses the input boundary.
import assert from "node:assert/strict";
import { test } from "node:test";
import { World, rules } from "../sim/world.ts";
import { rows } from "../kernel/evolve.ts";
import { parseEvent } from "../protocol/validate.ts";
import { checkSchema } from "../protocol/schema.ts";
test("published event schema accepts the same depth as the runtime", () => {
  assert.deepEqual(checkSchema("event", { id: "one", type: "one", hops: 8 }), []);
  assert.notDeepEqual(checkSchema("event", { id: "one", type: "one", hops: -1 }), []);
  // Deeper than the dispatch cutoff is still a valid event — it is recorded and not dispatched — so a schema capped at
  // the cutoff would refuse what the runtime takes.
  assert.equal(parseEvent({ id: "one", type: "one", hops: 9 }).hops, 9);
  assert.deepEqual(checkSchema("event", { id: "one", type: "one", hops: 9 }), []);
});
test("receipt events cannot forge hops; over eight is recorded without dispatch", () => {
  const w = new World();
  const r = structuredClone(rules);
  r.rules[0].emits = { source: "app", types: ["one"] };
  w.call("rules", r);
  w.call("ingest", "app", { id: "loop", type: "one", hops: 8 });
  const job = w.call("claimNext", "w1", "c");
  assert.equal(job.context.events[0].hops, 8);
  w.call("finish", job.run, job.token, { outcome: "done", events: [{ id: "next", type: "one", hops: 0 }] });
  const e = rows(w.view, "events").find((e) => e.key === "next")!;
  assert.equal(e.hops, 9);
  assert.equal(e.routed, "[]");
  assert.equal(w.call("claimNext", "w1", "d"), null);
  assert.ok(rows(w.view, "cards").some((c) => c.text.includes("8")));
});
test("answers and timers inherit the original chain depth", () => {
  const w = new World();
  w.call("ingest", "app", { id: "depth", type: "one", subject: "depth", hops: 7 });
  const job = w.call("claimNext", "w1", "c");
  w.call("finish", job.run, job.token, {
    outcome: "done",
    ask: [{ key: "q", title: "选", text: "选", options: ["甲", "乙"] }],
    later: [{ key: "t", at: "1970-01-01T00:01:00Z", about: "查" }],
  });
  w.call("answer", 1, { choice: 0 });
  w.advance(60000);
  assert.deepEqual(
    rows(w.view, "events").map((e) => e.hops),
    [7, 7, 7],
  );
});
test("depth defaults to zero and rejects negative, fractional or unbounded numbers", () => {
  assert.equal(parseEvent({ id: "a", type: "one" }).hops, 0);
  for (const hops of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"])
    assert.throws(() => parseEvent({ id: "a", type: "one", hops }));
});
