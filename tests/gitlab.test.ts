// GitLab webhooks. Failure modes: a wrong or missing token is taken; the action isn't in the event's type; a retried
// delivery counts twice; a later event on the same merge request is dropped as a duplicate of an earlier one;
// comments on different issues or merge requests collapse into the same repository-wide subject.
import assert from "node:assert/strict";
import { test } from "node:test";
import gitlab from "../plugins/gitlab/source.ts";

const secret = "test-secret";
const headers = (extra: Record<string, string | undefined> = {}) => ({
  "x-gitlab-token": secret,
  "idempotency-key": "evt-12345",
  ...extra,
});
const noKey = headers({ "idempotency-key": undefined });

const mergeRequest = (action: string) =>
  JSON.stringify({
    object_kind: "merge_request",
    object_attributes: {
      id: 98765,
      iid: 42,
      action,
      title: "Fix login flow",
      url: "https://gitlab.com/org/proj/merge_requests/42",
      description: "Fixes the login flow for mobile.",
    },
    project: { path_with_namespace: "org/proj", web_url: "https://gitlab.com/org/proj" },
  });

test("gitlab: a merge request event carries its action, subject and words", () => {
  const [event] = gitlab({ headers: headers(), body: mergeRequest("open"), secret });
  assert.equal(event.type, "merge_request.open");
  assert.equal(event.subject, "org/proj#42");
  assert.equal(event.summary, "Fix login flow");
  assert.equal(event.detail, "Fixes the login flow for mobile.");
  assert.equal(event.link, "https://gitlab.com/org/proj/merge_requests/42");
  assert.equal(event.id, "evt-12345");
});

test("gitlab: a push has no number in its subject", () => {
  const body = JSON.stringify({
    object_kind: "push",
    commits: [{ message: "Add a thing" }],
    project: { path_with_namespace: "org/proj", web_url: "https://gitlab.com/org/proj" },
  });
  const [event] = gitlab({ headers: headers(), body, secret });
  assert.equal(event.type, "push");
  assert.equal(event.subject, "org/proj");
  assert.equal(event.summary, "Add a thing");
});

test("gitlab: comments keep the subject of their issue or merge request", () => {
  // https://docs.gitlab.com/user/project/integrations/webhook_events/#comment-events
  for (const target of ["issue", "merge_request"]) {
    for (const iid of [42, 43]) {
      const object = { id: 98765 + iid, iid, title: "Fix login flow" };
      const project = { path_with_namespace: "org/proj" };
      const [opened] = gitlab({
        headers: noKey,
        body: JSON.stringify({ object_kind: target, project, object_attributes: { ...object, action: "open" } }),
        secret,
      });
      const [comment] = gitlab({
        headers: noKey,
        body: JSON.stringify({
          object_kind: "note",
          project,
          object_attributes: {
            id: 12345,
            note: "Please check mobile login",
            noteable_type: target === "issue" ? "Issue" : "MergeRequest",
            noteable_id: object.id,
            action: "create",
            url: `https://gitlab.com/org/proj/${target}s/${iid}#note_12345`,
          },
          [target]: object,
        }),
        secret,
      });
      assert.equal(comment.subject, `org/proj#${iid}`);
      assert.equal(comment.subject, opened.subject);
      assert.equal(comment.type, "note.create");
      assert.equal(comment.detail, "Please check mobile login");
      assert.equal(comment.link, `https://gitlab.com/org/proj/${target}s/${iid}#note_12345`);
    }
  }
});

test("gitlab: without Idempotency-Key a retry keeps its id and a later event gets its own", () => {
  const id = (body: string) => gitlab({ headers: noKey, body, secret })[0].id;
  assert.equal(id(mergeRequest("open")), id(mergeRequest("open")));
  assert.notEqual(id(mergeRequest("open")), id(mergeRequest("update")));
});

test("gitlab: a wrong or missing token is refused", () => {
  const body = mergeRequest("open");
  assert.throws(() => gitlab({ headers: { "x-gitlab-token": "wrong-secret" }, body, secret }), /signature/);
  assert.throws(() => gitlab({ headers: {}, body, secret }), /signature/);
  assert.throws(() => gitlab({ headers: headers(), body, secret: "" }), /signature/);
});
