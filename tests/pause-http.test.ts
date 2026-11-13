// Rule control over HTTP and from the command line. Failure cases: someone other than the owner pauses, resumes or runs a
// rule; an unknown rule gets a 200 or a 500 instead of saying it isn't there; a misspelt field is ignored; running a
// paused rule is accepted; the state doesn't show who paused what, why and until when; a task that runs elsewhere, even one that can ask and go on in its cwd, is paused or run as if it were a rule; the
// command line doesn't reach these doors or says nothing useful. What a pause skipped isn't counted while it lasts, isn't
// listed in full when it's lifted, takes in what an earlier pause skipped, or can't be replayed in one go after the lift;
// the command line doesn't say a pause holds nothing back for later, or leaves the owner to find the skipped events.
// The state leaves out the model a task elsewhere was registered with, or makes one up for a task that named none.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setup, beforeCleanup } from "./helpers.ts";

const home = setup("pause-http");
const rulesFile = join(home, "rules.json");
const fixture = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_RULES!, "utf8"));
fixture.elsewhere.push({
  ...fixture.elsewhere[0],
  name: "会问的清理",
  cwd: "/tmp",
  prompt: "接着清理。",
  model: "some-model",
  effort: "high",
});
writeFileSync(rulesFile, JSON.stringify(fixture));
process.env.AGENT_AUTOLOOP_RULES = rulesFile;
const { serve } = await import("../host/http.ts");
const { addKey, db } = await import("../host/runtime.ts");
beforeCleanup.push(() => {
  if (db.isOpen) db.close();
});

const owner = addKey("owner", "owner");
const worker = addKey("worker", "w1");
const source = addKey("source", "app");
const server = serve(0, "127.0.0.1");
let base = "";
before(async () => {
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: base, owner }));
});
after(() => {
  server.closeAllConnections();
  server.close();
});

async function post(path: string, body?: unknown, key = owner) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}
const state = async () => (await fetch(`${base}/v1/state`, { headers: { authorization: `Bearer ${owner}` } })).json();
test("a task elsewhere shows the model and effort it was registered with, and none when it named none", async () => {
  const { elsewhere } = await state();
  const named = elsewhere.find((task: any) => task.name === "会问的清理");
  assert.deepEqual([named.model, named.effort], ["some-model", "high"]);
  const plain = elsewhere.find((task: any) => task.name !== "会问的清理");
  assert.deepEqual(["model" in plain, "effort" in plain], [false, false]);
});

const lineOf = async (name: string) => (await state()).lines.find((line: { name: string }) => line.name === name);
const rule = (name: string, action: string) => `/v1/rules/${encodeURIComponent(name)}/${action}`;
const send = async (id: string, subject: string) =>
  (await post("/v1/events", { id, type: "feedback.new", subject, summary: `${subject} 的意见` }, source)).json.event;

test("only the owner controls rules", async () => {
  for (const path of [rule("巡检", "pause"), rule("巡检", "resume"), rule("巡检", "run")]) {
    assert.equal((await post(path, {}, worker)).status, 401, path);
    assert.equal((await post(path, {}, "made-up")).status, 401, path);
  }
});

test("pause, see it in the state, refuse a run, resume, run", async () => {
  const until = new Date(Date.now() + 3600_000).toISOString();
  const paused = await post(rule("巡检", "pause"), { reason: "上游在修", until });
  assert.equal(paused.status, 200);
  assert.equal(paused.json.changed, true);
  const shown = await lineOf("巡检");
  assert.deepEqual([shown.paused.by, shown.paused.reason, shown.paused.until], ["owner", "上游在修", until]);
  assert.ok(shown.paused.since);
  assert.deepEqual(
    (await state()).pauses.map((p: any) => [p.name, p.reason]),
    [["巡检", "上游在修"]],
  );
  assert.equal((await post(rule("巡检", "pause"), { reason: "上游在修", until })).json.changed, false);
  const refused = await post(rule("巡检", "run"));
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /暂停中/);
  assert.equal((await post(rule("巡检", "resume"))).json.changed, true);
  assert.equal((await lineOf("巡检")).paused, null);
  const ran = await post(rule("巡检", "run"), { reason: "看一眼" });
  assert.equal(ran.status, 200);
  const run = (await state()).runs.find((r: any) => r.id === ran.json.run);
  assert.deepEqual([run.rule, run.state, run.manual, run.events[0].type], ["巡检", "queued", true, "run.manual"]);
});

test("what a pause skips is counted while it lasts, listed when it's lifted, and replayed once", async () => {
  await post(rule("意见", "pause"), { reason: "上一次" });
  const earlier = await send("h0", "#0");
  await post(rule("意见", "resume"));
  const paused = await post(rule("意见", "pause"), { reason: "下游在修" });
  assert.deepEqual(paused.json.paused.skipped, { count: 0, events: [] });
  const first = await send("h1", "#1");
  const second = await send("h2", "#2");
  const shown = (await lineOf("意见")).paused.skipped;
  assert.deepEqual([shown.count, shown.events.map((e: any) => e.id)], [2, [second, first]]);
  const since = paused.json.paused.since;
  assert.equal((await post(rule("意见", "replay"), { since })).status, 409, "not while still paused");
  const resumed = await post(rule("意见", "resume"));
  assert.equal(resumed.json.paused.since, since);
  assert.deepEqual(
    resumed.json.paused.skipped.events.map((e: any) => [e.id, e.source, e.type, e.subject, e.summary]),
    [
      [second, "app", "feedback.new", "#2", "#2 的意见"],
      [first, "app", "feedback.new", "#1", "#1 的意见"],
    ],
  );
  assert.equal(resumed.json.paused.skipped.count, 2, "only this pause's");
  assert.equal((await post(rule("意见", "replay"), {})).status, 400);
  assert.equal((await post(rule("意见", "replay"), { since }, worker)).status, 401);
  const replayed = await post(rule("意见", "replay"), { since });
  assert.deepEqual(replayed.json.events, [first, second]);
  assert.equal(replayed.json.runs.length, 2);
  assert.deepEqual((await post(rule("意见", "replay"), { since })).json, { events: [], runs: [] });
  assert.ok(
    (await state()).skipped.some((e: any) => e.id === earlier),
    "what the earlier pause skipped stays as it was",
  );
  const schedule = await post(rule("巡检", "pause"), {});
  assert.equal(schedule.json.paused.skipped, null, "a schedule skips moments, not events");
  await post(rule("巡检", "resume"));
});

test("a wrong name or body says what is wrong", async () => {
  const unknown = await post(rule("没有的", "pause"), {});
  assert.equal(unknown.status, 404);
  assert.match(unknown.json.error, /没有这条规则：没有的/);
  assert.equal((await post(rule("没有的", "run"))).status, 404);
  for (const task of ["每周清理", "会问的清理"]) {
    for (const action of ["pause", "run"]) {
      const elsewhere = await post(rule(task, action), {});
      assert.equal(elsewhere.status, 400, `${task} ${action}`);
      assert.match(elsewhere.json.error, /在别处跑的定时任务/);
    }
  }
  const misspelt = await post(rule("巡检", "pause"), { reson: "x" });
  assert.equal(misspelt.status, 400);
  assert.match(misspelt.json.error, /reson/);
  assert.equal((await post(rule("巡检", "pause"), { until: "明天" })).status, 400);
  assert.equal((await post(rule("巡检", "pause"), [])).status, 400);
});

// Not spawnSync: the hub answering it runs in this process.
const cli = (...args: string[]) =>
  new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    const program = ["--disable-warning=ExperimentalWarning", "bin/agent-autoloop.ts", ...args];
    execFile(process.execPath, program, { cwd: join(import.meta.dirname, "..") }, (error, stdout, stderr) =>
      resolve({ status: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
    );
  });

test("the command line pauses, resumes and runs", async () => {
  let done = await cli("pause", "早报", "--reason", "放假");
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /暂停了「早报」/);
  done = await cli("status");
  assert.match(done.stdout, /暂停中[\s\S]*早报：放假/);
  done = await cli("run", "早报");
  assert.equal(done.status, 1);
  assert.match(done.stderr, /暂停中/);
  done = await cli("resume", "早报");
  assert.match(done.stdout, /恢复了「早报」/);
  done = await cli("run", "早报");
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /排上了：第 \d+ 轮/);
  done = await cli("pause", "没有的");
  assert.equal(done.status, 1);
  assert.match(done.stderr, /没有这条规则/);
});

test("the command line says a pause holds nothing back, lists what it skipped on resume, and replays it", async () => {
  let done = await cli("pause", "意见", "--reason", "下游在修");
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /暂停了「意见」。\n.*来的事件.*不排队.*恢复时会列出/);
  await send("c1", "#5");
  done = await cli("status");
  assert.match(done.stdout, /意见：下游在修\n.*跳过 1 条事件\n.*#5：#5 的意见/);
  done = await cli("resume", "意见");
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /恢复了「意见」。.*跳过了 1 条事件，没有补跑：\n.*#5：#5 的意见/);
  const [, since] = /补跑这 1 条：agent-autoloop replay 意见 --since (\S+)/.exec(done.stdout) ?? [];
  assert.ok(since, done.stdout);
  done = await cli("replay", "意见", "--since", since);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /补跑了 1 条，排上了第 \d+ 轮/);
  done = await cli("replay", "意见", "--since", since);
  assert.match(done.stdout, /没有要补跑的事件/);
  done = await cli("replay", "意见");
  assert.equal(done.status, 1);
  assert.match(done.stderr, /--since/);
});
