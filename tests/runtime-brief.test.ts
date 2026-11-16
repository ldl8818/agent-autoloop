// Failure modes: a daily brief mixes projects, counts retries twice, hides pending decisions or offline workers,
// uses yesterday's date at Beijing midnight, or publishes an error response (including credentials) as a healthy brief.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { brief } from "../scripts/runtime-brief.ts";
import { readMessage, resultFrom } from "../worker/contract.ts";

const counts = (doneToday = 0, queued = 0, retrying = 0, unknown = 0) => ({
  doneToday,
  queued,
  retrying,
  unknown,
  running: 0,
});
const state = {
  now: "2026-11-12T17:00:00Z",
  timezone: "Asia/Shanghai",
  lines: [
    { id: "shop-fetch", agent: "fetch", totals: counts(2), paused: null },
    { id: "shop-check", agent: "planner", totals: counts(1, 1, 1), paused: null },
    { id: "ops-watch", agent: "watch", totals: counts(4, 0, 0, 1), paused: null },
    { id: "unrelated", agent: "other", totals: counts(99), paused: null },
  ],
  agents: [
    { id: "fetch", name: "取料", online: true },
    { id: "planner", name: "规划", online: true },
    { id: "watch", name: "运维", online: false },
    { id: "other", name: "别的程序", online: false },
  ],
  channels: [{ id: "feishu", name: "飞书", online: true }],
  cards: [
    { id: 20, rule: "shop-check", kind: "ask", title: "要不要继续？" },
    { id: 21, rule: "unrelated", kind: "ask", title: "别的项目" },
  ],
};

test("a brief scopes complete counters and pending decisions to each project using Beijing's date", () => {
  const notice = brief(state, ["shop", "ops"]);
  assert.match(notice.key, /2026-11-13$/);
  assert.match(notice.text, /shop：今日完成3轮，进行中0轮，排队1轮（其中重试1轮），待核实0轮/);
  assert.match(notice.text, /#20 要不要继续？/);
  assert.match(notice.text, /ops：今日完成4轮/);
  assert.match(notice.text, /接单程序离线：运维/);
  assert.doesNotMatch(notice.text, /别的项目|别的程序|99轮/);
  assert.equal(notice.fyi, true);
});

test("a quiet day still produces an informative notice without claiming business recovery", () => {
  const quiet = { ...state, lines: [state.lines[0]], cards: [] };
  const notice = brief(quiet, ["shop"]);
  assert.match(notice.text, /暂无待您决定的卡片/);
  assert.match(notice.text, /未发现重试、状态不明或接单程序离线/);
  assert.match(notice.text, /业务恢复仍以原事项验收为准/);
  assert.equal(notice.fyi, true);
  assert.throws(() => brief(quiet, ["missing"]), /没有规则/);
});

const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-runtime-brief-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("the command only reads state and emits a valid receipt; a denied read cannot publish a brief", async () => {
  const requests: string[] = [];
  let denied = false;
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    assert.equal(request.headers.authorization, "Bearer owner-test");
    response.writeHead(denied ? 403 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify(denied ? { error: "private-response-marker" } : state));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const config = join(scratch, "config.json");
  writeFileSync(
    config,
    JSON.stringify({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, owner: "owner-test" }),
  );
  const args = [join(import.meta.dirname, "../scripts/runtime-brief.ts"), config, "shop", "ops"];
  try {
    const ran = await promisify(execFile)(process.execPath, args);
    const parsed = resultFrom(readMessage(ran.stdout), {});
    assert.equal(parsed.problem, undefined);
    assert.equal(parsed.result.notice?.length, 1);
    assert.match(parsed.result.notice![0].text, /#20/);
    denied = true;
    await assert.rejects(promisify(execFile)(process.execPath, args), (error: any) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "");
      assert.match(error.stderr, /无法读取中台状态/);
      assert.doesNotMatch(error.stderr, /owner-test|private-response-marker/);
      return true;
    });
    assert.deepEqual(requests, ["GET /v1/state", "GET /v1/state"]);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
