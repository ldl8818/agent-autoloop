// Failure modes: a channel-only wording fix is lost on the next status update or log rebuild; correction wakes work,
// changes the question's choices or original message reference, overwrites a concurrent answer, or accepts another key kind.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { setup } from "./helpers.ts";
import { empty, evolve } from "../kernel/evolve.ts";
import { iterateLog } from "../kernel/store.ts";
import { render } from "../plugins/feishu/channel.ts";
import { hubClient } from "../protocol/client.ts";
import { checkSchema } from "../protocol/schema.ts";

setup("card-correction");
const hub = await import("./hub.ts");
const { serve } = await import("../host/http.ts");
const keys = Object.fromEntries(
  (["owner", "source", "worker", "channel"] as const).map((kind) => [kind, hub.addKey(kind, kind)]),
);
const server = serve(0);
let base = "";
before(async () => {
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});
const corrected = {
  version: 1,
  title: "配置变动待核对",
  text: "变动文件：example.conf。由维护者核对。",
  reason: "内部分类误称项目",
};
const at = (step: number) => Date.now() + step;
async function correct(id: number, body: unknown = corrected, key: string | undefined = keys.owner) {
  const response = await fetch(`${base}/v1/cards/${id}/correct`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key === undefined ? {} : { authorization: `Bearer ${key}` }) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
const card = (id: number) => hub.getView().get("cards", id)!;
const question = (key: string) => ({
  kind: "ask",
  key,
  title: "待维护项目",
  text: "待维护项目：configuration。",
  options: ["复查", "暂缓"],
  recommend: 0,
});

test("persistent correction reaches the same messages and survives answer, completion and fact replay", async () => {
  hub.ingest("app", { id: "correction", type: "feedback.new", subject: "#93" }, at(0));
  const job = hub.claimNext("w1", "correction", at(0))!;
  const { kind, ...ask } = question("correction");
  hub.finish(job.run, job.token, { outcome: "done", ask: [ask] }, at(0));
  const original = hub.nextCard("chat", at(0))!;
  assert(original.text.includes("configuration"), "the original failure must exist before correction");
  hub.delivered("chat", original.id, original.version, "original-chat-message", at(0));
  const plain = hub.nextCard("plain", at(0))!;
  hub.delivered("plain", plain.id, plain.version, "original-plain-message", at(0));
  const before = card(original.id);
  const events = hub.all("SELECT * FROM events"),
    runs = hub.all("SELECT * FROM runs");
  assert.deepEqual(await hubClient(base, keys.owner).correctCard(original.id, corrected), {
    changed: true,
    version: 2,
  });
  assert.deepEqual(card(original.id), {
    ...before,
    title: corrected.title,
    text: corrected.text,
    version: 2,
    correction: { reason: corrected.reason, by: "本人" },
  });
  assert.deepEqual(hub.all("SELECT * FROM events"), events);
  assert.deepEqual(hub.all("SELECT * FROM runs"), runs);
  for (const [channel, ref] of [
    ["chat", "original-chat-message"],
    ["plain", "original-plain-message"],
  ]) {
    const changed = hub.nextCard(channel, at(1))!;
    assert.deepEqual([changed.id, changed.ref, changed.text, changed.version], [original.id, ref, corrected.text, 2]);
    hub.delivered(channel, changed.id, changed.version, ref, at(1));
  }
  hub.answer(original.id, { choice: 1, by: "owner" }, at(2));
  const next = hub.claimNext("w1", "after-correction", at(2))!;
  assert.equal(next.context.answers[0].title, corrected.title);
  hub.finish(next.run, next.token, { outcome: "done", summary: "暂缓已记录" }, at(3));
  const settled = hub.nextCard("chat", at(3))!;
  assert.deepEqual([settled.state, settled.text, settled.ref], ["done", corrected.text, "original-chat-message"]);
  const rendered = JSON.stringify(render(settled, {}, "upstream"));
  assert(rendered.includes(corrected.text));
  assert(!rendered.includes("configuration"));
  const rebuilt = evolve(empty(), iterateLog(hub.db));
  try {
    assert.deepEqual(rebuilt.get("cards", original.id), card(original.id));
  } finally {
    rebuilt.close();
  }
  const history = hub.why(job.run);
  const fact = history.find((fact) => fact.type === "correctCard")!;
  assert.deepEqual(checkSchema("fact", fact), []);
  assert.deepEqual(fact.changes.find((change) => change.table === "cards")!.row!.correction, {
    reason: corrected.reason,
    by: "本人",
  });
  assert(
    history.some((fact) => JSON.stringify(fact).includes("configuration")),
    "original facts remain available",
  );
});

test("only the owner key can correct a card", async () => {
  const id = hub.createCard(question("correction-auth")).card;
  const before = card(id),
    seq = hub.getView().seq;
  for (const key of ["", "made-up", keys.source, keys.worker, keys.channel]) {
    assert.equal((await correct(id, corrected, key)).status, 401);
  }
  assert.equal((await correct(id)).status, 200);
  assert.equal(card(id).state, before.state);
  assert.equal(hub.getView().seq, seq + 1);
});

test("invalid, stale and answered corrections leave facts and business state unchanged; identical content is a no-op", async () => {
  const id = hub.createCard(question("correction-conflict")).card;
  const before = card(id),
    seq = hub.getView().seq;
  for (const body of [
    null,
    [],
    { ...corrected, version: 0 },
    { ...corrected, version: "1" },
    { ...corrected, title: " " },
    { ...corrected, title: "字".repeat(201) },
    { ...corrected, text: "字".repeat(4001) },
    { ...corrected, reason: "" },
    { ...corrected, reason: "字".repeat(1001) },
    { ...corrected, options: ["新的选项", "另一个选项"] },
  ]) {
    assert.equal((await correct(id, body)).status, 400);
  }
  assert.deepEqual(card(id), before);
  assert.equal(hub.getView().seq, seq);
  assert.equal((await correct(id, { ...corrected, version: 2 })).status, 409);
  assert.equal((await correct(999999)).status, 404);
  assert.deepEqual(await correct(id), { status: 200, body: { changed: true, version: 2 } });
  assert.equal((await correct(id)).status, 409);
  assert.deepEqual(await correct(id, { ...corrected, version: 2 }), {
    status: 200,
    body: { changed: false, version: 2 },
  });
  const correctedSeq = hub.getView().seq;
  assert.equal(correctedSeq, seq + 1);
  hub.answer(id, { choice: 0, by: "owner" });
  const answered = card(id),
    answeredSeq = hub.getView().seq;
  assert.equal((await correct(id, { ...corrected, version: answered.version })).status, 409);
  assert.deepEqual(card(id), answered);
  assert.equal(hub.getView().seq, answeredSeq);
});
