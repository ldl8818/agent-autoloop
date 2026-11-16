// Naming a run: `stop` and `why` with no number, or with a word that is not one, used to send /v1/runs/NaN to the hub and
// print "没有这个地址", which reads like a broken hub rather than a mistyped command. Found here by running the real program in a home nothing is installed into: the usage must come before any hub is asked.
// A hub that doesn't answer was said as a bare "fetch failed", with no word of which hub or what to do.
// A sandbox refusing a connection must not be diagnosed as a stopped hub or recommend reinstalling its service.
// The preload must be a file URL: Windows drive paths are parsed as unsupported URL schemes by --import.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const program = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-cli-run-id-"));
after(() => rmSync(dir, { recursive: true, force: true }));

async function run(args: string[], home = join(dir, "home"), preload?: string) {
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        ...(preload ? ["--import", pathToFileURL(preload).href] : []),
        program,
        ...args,
      ],
      { env: { ...process.env, AGENT_AUTOLOOP_HOME: home } },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

for (const args of [
  ["stop"],
  ["stop", "abc"],
  ["stop", "0"],
  ["stop", "1.5"],
  ["why"],
  ["why", "--json"],
  ["why", "x"],
]) {
  test(`${args.join(" ")} says how to name a run instead of asking the hub`, async () => {
    const ran = await run(args);
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, new RegExp(`用法：agent-autoloop ${args[0]} <第几轮>`));
  });
}

test("a real run number still goes on to the hub", async () => {
  for (const args of [
    ["stop", "3"],
    ["why", "3", "--json"],
    ["why", "--json", "3"],
  ]) {
    const ran = await run(args);
    assert.equal(ran.code, 1);
    assert.doesNotMatch(ran.stderr, /用法/);
    assert.match(ran.stderr, /还没装好/);
  }
});

test("a hub that doesn't answer is named, with what to do, not left as a bare fetch failed", async () => {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  probe.close();
  const home = join(dir, "nobody-home");
  mkdirSync(home);
  writeFileSync(join(home, "config.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, owner: "k" }));
  const ran = await run(["status"], home);
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, new RegExp(`连不上中台 http://127\\.0\\.0\\.1:${port}`));
  assert.match(ran.stderr, /service install/);
});

test("a denied connection reports the permission boundary instead of recommending a service install", async () => {
  const home = join(dir, "network-denied");
  mkdirSync(home);
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ url: "http://127.0.0.1:3350", owner: "owner-test", source: { key: "source-test" } }),
  );
  const preload = join(dir, "network-denied.mjs");
  for (const code of ["EPERM", "EACCES"]) {
    writeFileSync(
      preload,
      `globalThis.fetch = async () => { throw new TypeError("fetch failed", { cause: { code: "${code}" } }); };`,
    );
    for (const command of ["status", "try"]) {
      const ran = await run([command], home, preload);
      assert.equal(ran.code, 1);
      assert.match(ran.stderr, /权限|沙箱/);
      assert.match(ran.stderr, new RegExp(code));
      assert.doesNotMatch(ran.stderr, /service install|中台没在运行/);
    }
  }
});
