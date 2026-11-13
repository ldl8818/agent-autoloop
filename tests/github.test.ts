// GitHub comments longer than the summary are lost when the event detail carries the old issue body instead of the comment.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import github from "../plugins/github/source.ts";

const secret = "test-secret";

test("github: an issue comment carries its full words and the issue as its subject", () => {
  const comment = `${"A".repeat(200)}keep the rest of this comment`;
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
  assert.equal(event.summary, comment.slice(0, 200));
  assert.equal(event.detail, comment);
  assert.equal(event.link, "https://github.com/example/widgets/issues/42#issuecomment-1");
});
