// GitHub comments longer than the summary are lost when the event detail carries the old issue body instead of the comment.
// A comment long enough to be capped is cut through the middle of a character, so its last glyph reaches the agent as garbage.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import github from "../plugins/github/source.ts";

const secret = "test-secret";

test("github: an issue comment carries its full words and the issue as its subject", () => {
  // An emoji sits across each cap — units 199/200 for the summary and 3999/4000 for the detail — so a cut
  // that lands on the first half would hand the agent a lone surrogate instead of a character.
  const comment = `${"A".repeat(199)}😀${"A".repeat(3798)}😀keep the rest of this comment`;
  const body = JSON.stringify({
    action: "created",
    repository: { full_name: "example/widgets" },
    issue: {
      number: 42,
      title: "Original issue",
      body: "The old issue body",
      html_url: "https://github.com/example/widgets/issues/42",
    },
    comment: {
      body: comment,
      html_url: "https://github.com/example/widgets/issues/42#issuecomment-1",
    },
  });
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const [event] = github({
    headers: {
      "x-hub-signature-256": signature,
      "x-github-event": "issue_comment",
      "x-github-delivery": "delivery-1",
    },
    body,
    secret,
  });

  assert.equal(event.type, "issue_comment.created");
  assert.equal(event.subject, "example/widgets#42");
  assert.equal(event.summary, "A".repeat(199), "capped, and not through the emoji at the cut");
  assert.ok(comment.startsWith(event.detail), "the comment's own words, not the old issue body");
  assert.equal(event.detail.length, 3999, "capped, one unit short of the half character");
  assert.ok(!/[\ud800-\udbff]$/.test(event.detail), "not cut through a character");
  assert.equal(event.link, "https://github.com/example/widgets/issues/42#issuecomment-1");
});
