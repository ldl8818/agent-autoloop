// A trusted command reads the owner view; the worker delivers its notice through the existing channels.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { hubClient } from "../protocol/client.ts";

type Counts = { doneToday: number; running: number; queued: number; retrying: number; unknown: number };
type State = {
  now: string;
  timezone: string;
  lines: { id: string; agent: string; paused: unknown; totals: Counts }[];
  agents: { id: string; name: string; online: boolean }[];
  channels: { id: string; name: string; online: boolean }[];
  cards: { id: number; rule?: string; kind: string; title: string }[];
};

const belongsTo = (rule: string, project: string) => rule === project || rule.startsWith(`${project}-`);

// Card titles are data. Keep the brief compact without letting their Markdown change its structure.
const label = (text: string) =>
  Array.from(text.replace(/\s+/g, " "))
    .slice(0, 70)
    .join("")
    .replace(/[\\`*_[\]<>]/g, "\\$&");

export function brief(state: State, projects: string[]) {
  if (state.timezone !== "Asia/Shanghai") throw new Error("中台统计时区必须是 Asia/Shanghai");
  const at = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(state.now));
  const text = [`截至${at}（北京时间）。`];
  for (const project of projects) {
    const lines = state.lines.filter((line) => belongsTo(line.id, project));
    if (!lines.length) throw new Error(`项目 ${project} 没有规则`);
    const total = (field: keyof Counts) => lines.reduce((sum, line) => sum + line.totals[field], 0);
    const agents = new Set(lines.map((line) => line.agent));
    const offline = state.agents.filter((agent) => agents.has(agent.id) && !agent.online);
    const cards = state.cards.filter((card) => card.rule && belongsTo(card.rule, project));
    const asks = cards.filter((card) => card.kind === "ask");
    const notices = cards.filter((card) => card.kind === "notice");
    text.push(
      "",
      `${project}：今日完成${total("doneToday")}轮，进行中${total("running")}轮，` +
        `排队${total("queued")}轮（其中重试${total("retrying")}轮），待核实${total("unknown")}轮。`,
      total("retrying") || total("unknown") || offline.length
        ? "当前有执行异常，请核对重试、待核实轮次或离线接单程序。"
        : "未发现重试、状态不明或接单程序离线。",
      asks.length ? `待您决定：${asks.length}张卡片。` : "暂无待您决定的卡片。",
      ...asks.slice(0, 3).map((card) => `- #${card.id} ${label(card.title)}`),
      ...(asks.length > 3 ? ["其余事项请查看原卡片或运行 agent-autoloop status。"] : []),
      ...(notices.length ? [`未结通知：${notices.length}张。`] : []),
      ...(offline.length ? [`接单程序离线：${offline.map((agent) => label(agent.name)).join("、")}。`] : []),
      ...(lines.some((line) => line.paused) ? [`已暂停${lines.filter((line) => line.paused).length}条规则。`] : []),
    );
  }
  text.push(
    "",
    `通知通道：${state.channels.map((channel) => `${label(channel.name)}${channel.online ? "在线" : "离线"}`).join("、") || "未接入"}。`,
    "完成轮数是中台记录，业务恢复仍以原事项验收为准。",
  );
  return { title: "每日运行摘要", key: `runtime-brief-${at.slice(0, 10)}`, text: text.join("\n"), fyi: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [configFile, ...projects] = process.argv.slice(2);
    if (!configFile || !projects.length) throw new Error("需要配置文件和项目名称");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    if (typeof config.url !== "string" || typeof config.owner !== "string") throw new Error("缺少本人读取凭据");
    const notice = brief(await hubClient(config.url, config.owner).state(), projects);
    console.log(`每日运行摘要已生成。\n\n\`\`\`agent-autoloop\n${JSON.stringify({ notice: [notice] })}\n\`\`\``);
  } catch {
    // Transport errors may include server responses; neither those nor credentials belong in a notification.
    console.error("没跑成：无法读取中台状态或生成摘要，请检查中台连接、配置与项目规则。");
    process.exitCode = 1;
  }
}
