// GitHub webhooks, checked against the repository's secret and turned into events: `issues.opened`,
// `pull_request.labeled`, `issue_comment.created` and so on, the object's number as the subject. In rules.json:
//   "sources": { "github": { "name": "GitHub", "adapter": "github" } }, and AGENT_AUTOLOOP_SECRET_GITHUB in secrets.env.
import { createHmac, timingSafeEqual } from "node:crypto";

type Input = { headers: Record<string, string | string[] | undefined>; body: string; secret: string };

export default function github({ headers, body, secret }: Input) {
  const sign = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const given = String(headers["x-hub-signature-256"] ?? "");
  const signed = secret && given.length === sign.length && timingSafeEqual(Buffer.from(given), Buffer.from(sign));
  if (!signed) throw new Error("signature");
  const kind = String(headers["x-github-event"] ?? "");
  if (kind === "ping") return [];
  const payload = JSON.parse(body);
  const object = payload.pull_request ?? payload.issue ?? payload.discussion ?? payload.release ?? null;
  const type = (payload.action ? `${kind}.${payload.action}` : kind).toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  const repo = String(payload.repository?.full_name ?? "");
  const number = object?.number ? `#${object.number}` : "";
  return [
    {
      id: String(headers["x-github-delivery"] ?? ""),
      type,
      subject: `${repo}${number}`.replace(/[^A-Za-z0-9#._:/@-]/g, "-").slice(0, 100),
      summary: String(payload.comment?.body ?? object?.title ?? payload.head_commit?.message ?? "").slice(0, 200),
      detail: String(payload.comment?.body ?? object?.body ?? "").slice(0, 4000),
      link: encodeURI(
        String(payload.comment?.html_url ?? object?.html_url ?? payload.repository?.html_url ?? ""),
      ).slice(0, 500),
    },
  ];
}
