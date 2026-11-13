// ZCode: the CLI bundle that ships with the desktop app, run headless. `-p` answers one prompt and prints one JSON
// object at the end: sessionId, response, and the tokens its provider used. A resumed turn passes --resume sess_…,
// and ZCode's own modes are the access setting: plan reads, edit lets it work, yolo doesn't ask at all.
//
// The object is written once at the end, so a run that dies leaves no session id. It counts as started as soon as its
// process is running; the one failure that may start a fresh session is a resume id ZCode doesn't know.
import { execFileSync } from "node:child_process";
import { commandLine } from "../../host/command.ts";
import { findProgram, tail, type Adapter, type Reading, type Usage } from "../../worker/agents.ts";

const MODE = { read: "plan", edit: "edit", full: "yolo" } as const;

/** The Windows package is a .cjs bundle: node has to start it, not the platform. A native launcher is used as it is. */
function launch(program: string) {
  return /\.(?:cjs|mjs|js)$/i.test(program) ? [process.execPath, program] : [program];
}

/** The last complete JSON object in what it printed; the answer may come after a warning line. */
function lastJsonObject(text: string): any {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {}
  const end = text.lastIndexOf("}");
  if (end < 0) return null;
  // lastIndexOf with -1 still finds a brace at 0, so stop after trying the start of the text.
  for (let start = text.lastIndexOf("{", end); start >= 0; start = start ? text.lastIndexOf("{", start - 1) : -1) {
    try {
      const value = JSON.parse(text.slice(start, end + 1));
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {}
  }
  return null;
}

/** The provider's per-turn tokens. `inputTokens` already includes what came from its cache, as Codex's does. */
function usageOf(value: any): Usage | undefined {
  const raw = value?.usage;
  if (!raw || typeof raw !== "object") return undefined;
  const usage: Usage = {};
  for (const [from, to] of [
    ["inputTokens", "input"],
    ["outputTokens", "output"],
    ["cacheReadTokens", "cached"],
  ] as const) {
    if (typeof raw[from] === "number") usage[to] = raw[from];
  }
  return Object.keys(usage).length ? usage : undefined;
}

export default {
  command: (turn) => [
    ...launch(turn.program ?? findProgram("zcode")),
    "--mode",
    MODE[turn.access],
    "--surface",
    "terminal",
    "--no-color",
    "--json",
    ...(turn.resume ? ["--resume", turn.resume] : []),
    "-p",
    turn.prompt,
  ],
  read(stdout, code, stderr): Reading {
    const value = lastJsonObject(stdout);
    if (value) {
      const session = typeof value.sessionId === "string" && value.sessionId ? value.sessionId : undefined;
      const usage = usageOf(value);
      const text = typeof value.response === "string" ? value.response : "";
      if (code !== null && code !== 0) {
        return { session, usage, started: true, error: tail(stderr) || `退出码 ${code}：ZCode 没跑完这一轮` };
      }
      if (!text.trim()) return { session, usage, started: true, error: "ZCode 没有完成并留下实际结果" };
      return { text, session, usage, started: true, finished: true };
    }
    if (code === null) return { started: true };
    const said = tail(stderr);
    // A session id the CLI doesn't know is the one case where a new one is right. Anything else that got this far may
    // have done work, so it stays in the session it was told to go on in.
    const lost = /session not found/i.test(said);
    if (!said && code === 0) return { started: true, error: "ZCode 没有完成并留下实际结果" };
    return { started: !lost, error: said || `退出码 ${code}：没留下原因` };
  },
  check(program) {
    try {
      execFileSync(...commandLine([...launch(program ?? findProgram("zcode")), "version"]), {
        encoding: "utf8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return null;
    } catch (error) {
      return `ZCode 用不了：用 zcode -p "hi" 跑一次看看（${(error as Error).message.split("\n")[0]}）`;
    }
  },
} satisfies Adapter;
