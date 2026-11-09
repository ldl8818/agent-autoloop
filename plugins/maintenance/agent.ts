// Each stage is one ordinary worker round, including its native session and usage.
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { Adapter, Reading } from "../../worker/agents.ts";

export default {
  command: (turn) => [
    process.execPath,
    "--disable-warning=ExperimentalWarning",
    join(import.meta.dirname, "run.ts"),
    ...(turn.command ?? []),
    JSON.stringify({
      session: turn.session,
      resume: turn.resume,
      folder: turn.folder,
      contextFile: turn.contextFile,
      engine: existsSync(resolve(import.meta.dirname, "../../worker/agents.ts"))
        ? resolve(import.meta.dirname, "../..")
        : resolve(dirname(process.argv[1]), ".."),
    }),
  ],
  read(stdout, code, stderr) {
    let result: Reading = {};
    for (const line of stdout.split("\n")) {
      try {
        const row = JSON.parse(line);
        if (row.maintenance) result = { ...result, ...row.maintenance };
      } catch {}
    }
    if (code !== null && code !== 0)
      return { ...result, error: stderr.trim().slice(-500) || "维护阶段未完成，保留原记录后复查" };
    return result;
  },
} satisfies Adapter;
