// GitLab webhooks, checked against the project's secret token and turned into events: `merge_request.open`,
// `issue.close`, `push`, `note` and so on, the object's number as the subject. In rules.json:
//   "sources": { "gitlab": { "name": "GitLab", "adapter": "gitlab" } }, and AGENT_AUTOLOOP_SECRET_GITLAB in secrets.env.
import { createHash, timingSafeEqual } from "node:crypto";

type Input = { headers: Record<string, string | string[] | undefined>; body: string; secret: string };

export default function gitlab({ headers, body, secret }: Input) {
  const given = String(headers["x-gitlab-token"] ?? "");
  const signed = secret && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!signed) throw new Error("signature");
  const payload = JSON.parse(body);
  const kind = String(payload.object_kind ?? headers["x-gitlab-event"] ?? "");
  const attributes = payload.object_attributes ?? {};
  const type = (attributes.action ? `${kind}.${attributes.action}` : kind).toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
  const project = payload.project ?? {};
  const repo = String(project.path_with_namespace ?? project.name ?? "");
  const object = kind === "note" ? (payload.merge_request ?? payload.issue ?? attributes) : attributes;
  const number = object.iid ? `#${object.iid}` : "";
  return [
    {
      // GitLab before 17.4 has no such header. The body is the same on a retry and differs between events.
      id: String(headers["idempotency-key"] ?? createHash("sha256").update(body).digest("hex")),
      type,
      subject: `${repo}${number}`.replace(/[^A-Za-z0-9#._:/@-]/g, "-").slice(0, 100),
      summary: String(attributes.title ?? payload.commits?.[0]?.message ?? "").slice(0, 200),
      detail: String(attributes.description ?? attributes.note ?? "").slice(0, 4000),
      link: encodeURI(String(attributes.url ?? project.web_url ?? "")).slice(0, 500),
    },
  ];
}
