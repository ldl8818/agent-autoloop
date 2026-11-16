// A retry cannot inherit another head's errors, forget its one check restart, or notify an owner whose agent is waiting;
// a notify program never receives half a character where the owner's own words were cut.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { tellQuestion, tellReturn, unattendedFailure, retryHandoff } from "../plugins/delivery/handoff.ts";

const head = "a".repeat(40);
const now = Date.parse("2026-10-30T12:00:00Z");

test("GitHub errors get an hour without using up the five regular retries", () => {
  const due = { key: "delivery-retry", about: JSON.stringify({ head, github: 59, execution: 3 }) };
  const next = retryHandoff([due], head, false, now);
  assert.deepEqual(JSON.parse(next!.about), { head, github: 59, execution: 4 });
  assert.equal(next!.at, "2026-10-30T12:01:00.000Z");
  assert.equal(retryHandoff([due], head, true, now), null);
  const unreachable = retryHandoff([due], head, true, now, false);
  assert.deepEqual(JSON.parse(unreachable!.about), { head, github: 60, execution: 3 });
  assert.deepEqual(JSON.parse(retryHandoff([due], "b".repeat(40), true, now)!.about).github, 1);
});

test("the retry receipt keeps a check restart across errors and drops it for a new head", () => {
  const recovery = { head, after: 12 };
  const first = retryHandoff([], head, false, now, true, recovery)!;
  assert.deepEqual(JSON.parse(first.about), { head, github: 0, execution: 1, checkAfter: 12 });
  const second = retryHandoff([first], head, true, now)!;
  assert.deepEqual(JSON.parse(second.about), { head, github: 1, execution: 1, checkAfter: 12 });
  const changed = retryHandoff([second], "b".repeat(40), false, now, true, recovery)!;
  assert.deepEqual(JSON.parse(changed.about), { head: "b".repeat(40), github: 0, execution: 1 });
});

test("an attended return is eligible for notice only after three minutes and without a fresh handoff", () => {
  const labels = [{ name: "deliver-attended" }];
  const failed = { state: "failure", created_at: "2026-10-30T11:57:00Z", description: "请修复" };
  assert.equal(unattendedFailure(labels, failed, now), true);
  assert.equal(unattendedFailure(labels, failed, now - 1), false);
  assert.equal(unattendedFailure([...labels, { name: "deliver" }], failed, now), false);
  assert.equal(unattendedFailure(labels, { ...failed, state: "pending" }, now), false);
});

const root = mkdtempSync(join(tmpdir(), "agent-autoloop-handoff-"));
after(() => rmSync(root, { recursive: true, force: true }));
const notices = join(root, "notices.txt");
const notify = join(root, "notify.mjs");
writeFileSync(notices, "");
writeFileSync(
  notify,
  `#!${process.execPath}
import { appendFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
appendFileSync(${JSON.stringify(notices)}, input + "\\n");
`,
  { mode: 0o755 },
);

/** The units a cut left without their partner: what a notify program shows as a broken character. */
function loneUnits(text: string) {
  const at: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    const isHigh = unit >= 0xd800 && unit <= 0xdbff;
    const isLow = unit >= 0xdc00 && unit <= 0xdfff;
    if (!isHigh && !isLow) continue;
    const partner = isHigh ? text.charCodeAt(index + 1) : text.charCodeAt(index - 1);
    const paired = isHigh ? partner >= 0xdc00 && partner <= 0xdfff : partner >= 0xd800 && partner <= 0xdbff;
    if (!paired) at.push(index);
  }
  return at;
}

test(
  "a cut in the owner's own words never hands the notify program half a character",
  { skip: process.platform === "win32" && "the fake notify program runs by its #! line, which Windows doesn't read" },
  () => {
    // 300 code points but 301 code units, so a cut counted in units lands inside the last one.
    const reason = "a".repeat(299) + "😀";
    tellReturn(notify, "example/app", 7, "a".repeat(40), reason);
    const returned = JSON.parse(readFileSync(notices, "utf8").trim()).text;
    assert.deepEqual(loneUnits(returned), []);
    assert.ok(returned.includes(reason));

    writeFileSync(notices, "");
    // 600 code points but 601 code units, for the longer cut the question path makes.
    const asked = "a".repeat(599) + "😀";
    const url = "https://github.com/example/app/issues/8";
    tellQuestion(notify, "example/app", { number: 8, title: "要决定", body: asked, html_url: url });
    const question = JSON.parse(readFileSync(notices, "utf8").trim()).text;
    assert.deepEqual(loneUnits(question), []);
    assert.ok(question.includes(asked));
  },
);
