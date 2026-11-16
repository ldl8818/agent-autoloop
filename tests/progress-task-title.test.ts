// Automatic progress cards must display the task name while retaining stored identity and callbacks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, evolve, rows } from "../kernel/evolve.ts";
import { parseRules } from "../protocol/rules.ts";
import { render } from "../plugins/feishu/channel.ts";

for (const [template, expected] of [
  ["修复补抓等待误报", "修复补抓等待误报"],
  ["修复{id}：{subject}", "修复129：issues/#129"],
]) {
  test("progress metadata preserves card identity and placeholder semantics: " + template, () => {
    const input = JSON.parse(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"));
    input.rules = [{ ...input.rules[0], parallel: undefined, title: template, tell: "always" }];
    let view = empty();
    let now = Date.UTC(2026, 10, 16);
    const env = { secret: "test", publicUrl: "https://hub.test" };
    const act = (type: string, ...args: any[]) => {
      const result = decide(view, { type, args }, now++, env);
      view = evolve(view, result.facts);
      return result.value;
    };
    act("rules", parseRules(JSON.stringify(input), 0, "UTC"));
    act("ingest", "app", { id: "first", type: "feedback.new", subject: "issues/#129" });
    const job = act("claimNext", "w1", "claim");
    act("finish", job.run, job.token, { outcome: "done", summary: "候选已验证，尚未上线。" });
    const stored = structuredClone(rows(view, "cards")[0]);
    const card = act("nextCard", "chat");
    assert.equal(card.taskTitle, expected);
    assert.equal(card.id, stored.id);
    assert.equal(card.version, stored.version);
    assert.equal(card.rule, stored.rule);
    assert.deepEqual(rows(view, "cards")[0], stored);
  });
}

test("both card styles replace an internal progress title, preserving Chinese titles and callback identity", () => {
  const internal = "caipiao-development-decision-129-decision-129";
  const base = {
    id: 130,
    version: 1,
    ref: null,
    kind: "notice" as const,
    state: "closed" as const,
    title: internal,
    rule: internal,
    text: "候选已验证，尚未上线。",
    options: [],
    recommend: null,
    choice: null,
    answer: null,
    result: null,
    link: null,
    taskTitle: "修复彩票补抓等待被误报为失败",
  };
  for (const style of ["upstream", "custom"] as const) {
    const original = structuredClone(base);
    const card = render(base, { "caipiao-": "caipiao" }, style);
    assert.equal(card.header.title.content, "caipiao｜修复彩票补抓等待被误报为失败｜进度通知");
    assert.deepEqual(base, original);
    const named = render({ ...base, title: "主人指定的具体事项" }, { "caipiao-": "caipiao" }, style);
    assert.equal(named.header.title.content, "caipiao｜主人指定的具体事项｜进度通知");
    const legacy = render({ ...base, taskTitle: undefined }, { "caipiao-": "caipiao" }, style);
    assert.equal(legacy.header.title.content, "caipiao｜功能修复｜进度通知");
    const fullTitle = "shop-" + "明确指定的中文事项".repeat(8);
    const ask = render(
      {
        ...base,
        kind: "ask",
        state: "open",
        title: fullTitle,
        rule: fullTitle,
        options: ["继续", "暂缓"],
        taskTitle: undefined,
      },
      { "shop-": "店铺" },
      style,
    );
    if (style === "custom") {
      assert.ok(JSON.stringify(ask).includes(fullTitle), "explicit long titles must remain readable in full");
    }
  }
});
