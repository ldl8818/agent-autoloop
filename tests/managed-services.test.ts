// Failure modes: doctor rejects a healthy externally managed install, or counts a loaded but stopped service as running.
// Fake launchctl only answers read queries; no service or production configuration is changed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("managed-services");
const person = join(home, "person");
const fakes = join(home, "fakes");
const calls = join(home, "calls");
mkdirSync(person);
mkdirSync(fakes);
const labels = ["com.example.hub", "com.example.business", "com.example.maintenance"];
const hub = createServer((_, response) => response.end(JSON.stringify({ ok: true, commit: "fixture" }))).listen(
  0,
  "127.0.0.1",
);
await once(hub, "listening");
after(() => hub.close());

function launchctl(states = ["running", "running", "running"], status = 0) {
  writeFileSync(calls, "");
  writeFileSync(
    join(fakes, "launchctl"),
    `#!/bin/sh
echo "$*" >> "${calls}"
[ "$1" = print ] || exit 99
case "$2" in
${labels.map((label, i) => `  */${label}) printf '\tstate = ${states[i]}\n\tpid = 123\n\tresource = {\n\t\tstate = running\n\t}\n'; exit ${status} ;;`).join("\n")}
esac
exit 113
`,
  );
  chmodSync(join(fakes, "launchctl"), 0o755);
}

async function doctor(managedServices: unknown = { launchd: labels }, platform = "darwin", registered = true) {
  const url = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  writeFileSync(join(home, "config.json"), JSON.stringify({ url, ...(registered ? { managedServices } : {}) }));
  const child = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--import",
      `data:text/javascript,Object.defineProperty(process,"platform",{value:${JSON.stringify(platform)}})`,
      join(import.meta.dirname, "..", "bin", "agent-autoloop.ts"),
      "doctor",
    ],
    { env: { ...process.env, HOME: person, PATH: `${fakes}:${process.env.PATH}` } },
  );
  let stdout = "";
  child.stdout.on("data", (data) => (stdout += data));
  child.stderr.resume();
  const [code] = await once(child, "close");
  return { code, stdout };
}

test("doctor accepts all registered managed services and never tries to install or restart them", async () => {
  launchctl();
  const result = await doctor();
  assert.equal(result.code, 0, result.stdout);
  for (const label of labels) assert.ok(result.stdout.includes(`● 受管服务在跑：${label}`));
  assert.doesNotMatch(result.stdout, /系统服务没在跑|service install/);
  const queries = readFileSync(calls, "utf8").trim().split("\n");
  assert.equal(queries.length, 3);
  assert.ok(queries.every((query) => query.startsWith("print gui/")));
});

test("a stopped service fails doctor even with a healthy hub and nested running state", async () => {
  launchctl(["running", "waiting", "running"]);
  const result = await doctor();
  assert.equal(result.code, 1);
  assert.match(result.stdout, /○ 受管服务未运行：com.example.business/);
  assert.match(result.stdout, /● 中台/);
  assert.doesNotMatch(result.stdout, /service install/);
});

test("unloaded services and failed queries remain failures instead of hiding behind hub health", async () => {
  for (const status of [113, 5]) {
    launchctl(undefined, status);
    const result = await doctor();
    assert.equal(result.code, 1);
    assert.match(result.stdout, status === 113 ? /未载入/ : /查询失败/);
    assert.doesNotMatch(result.stdout, /service install/);
  }
});

test("invalid registration or an unsupported manager cannot report success", async () => {
  for (const managed of [{ launchd: [] }, { launchd: ["../other"] }, {}]) {
    const result = await doctor(managed);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /受管服务配置/);
  }
  const result = await doctor({ launchd: labels }, "linux");
  assert.equal(result.code, 1);
  assert.match(result.stdout, /launchd/);
});

test("without managed services the default service diagnostic stays unchanged", async () => {
  launchctl();
  const result = await doctor(undefined, "darwin", false);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /系统服务没在跑：agent-autoloop service install/);
  assert.equal(readFileSync(calls, "utf8"), "");
});
