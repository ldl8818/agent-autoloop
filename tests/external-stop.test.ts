// A local proxy exiting cannot mark a remote turn stopped; pending cancellation must survive and not block other work.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("external-stop");
const available = join(home, "provider-ready");
const calls = join(home, "calls");
const ruleFile = join(home, "rules.json");
process.env.AGENT_AUTOLOOP_RULES = ruleFile;
mkdirSync(join(home, "plugins/external"), { recursive: true });
writeFileSync(
  join(home, "plugins/external/agent.ts"),
  `
export default {
  command: () => ["/bin/sh", "-c", ${JSON.stringify(`echo business >>'${calls}'; printf '{"session":"original","started":true,"external":true}\\n'; sleep 30`)}],
  cancel: () => ["/bin/sh", "-c", ${JSON.stringify(`echo control >>'${calls}'; if [ -f '${available}' ]; then printf '{"session":"original","started":true,"external":false}\\n'; else printf '{"session":"original","started":true,"external":true}\\n'; exit 1; fi`)}],
  read(stdout, code) { const value = JSON.parse(stdout.trim() || '{}'); return {...value, ...(code !== null && {error:'cancel control'})}; },
};`,
);
writeFileSync(
  ruleFile,
  JSON.stringify({
    sources: { app: { name: "test" } },
    channels: {},
    agents: {
      remote: { name: "remote", worker: "test", use: "external", timeout: 1 },
      plain: { name: "plain", worker: "test", use: "command", command: ["/bin/echo", "done"] },
    },
    rules: [
      { name: "remote", when: { source: "app", types: ["remote"] }, to: "remote", cwd: home, prompt: "work" },
      { name: "other", when: { source: "app", types: ["other"] }, to: "plain", cwd: home, prompt: "other" },
    ],
  }),
);
const hub = await import("./hub.ts");
const { createWorker } = await import("../worker/worker.ts");

test(
  "the real kernel keeps an unconfirmed external cancellation unknown until its stop is read back",
  { skip: process.platform === "win32" },
  async () => {
    let clock = Date.now();
    hub.addKey("worker", "test");
    const worker = createWorker({
      name: "test",
      wait: 0,
      capacity: 1,
      now: () => clock,
      hub: {
        work: async (query) => {
          hub.heartbeat("test", query.running, clock);
          return {
            job: query.capacity ? hub.claimNext("test", query.claim, clock) : null,
            cancel: hub.cancels("test"),
          };
        },
        started: async (run, token, body) => hub.started(run, token, body, clock),
        result: async (run, token, body) => hub.finish(run, token, body, clock),
      },
    });

    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, "worker did not settle");
        await worker.tick();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    hub.ingest("app", { id: "remote", type: "remote" }, clock);
    await until(() => {
      try {
        return readFileSync(calls, "utf8").includes("business");
      } catch {
        return false;
      }
    });
    const run = worker.entries()[0].run;
    hub.cancel(run, clock);
    await until(
      () =>
        worker.entries().some((entry: any) => entry.unconfirmed !== undefined) ||
        hub.stateOf(clock).runs.some((entry: any) => entry.id === run && entry.state === "cancelled"),
    );
    assert.notEqual(hub.stateOf(clock).runs.find((entry: any) => entry.id === run)!.state, "cancelled");
    clock += 6 * 60_000;
    await worker.tick();
    await until(() => worker.entries().some((entry: any) => entry.unconfirmed !== undefined));
    hub.sweep(clock);
    assert.equal(hub.stateOf(clock).runs.find((entry: any) => entry.id === run)!.state, "unknown");
    hub.ingest("app", { id: "other", type: "other" }, clock);
    await until(() => hub.stateOf(clock).runs.some((entry: any) => entry.rule === "other" && entry.state === "done"));
    writeFileSync(available, "ready");
    clock += 61_000;
    await until(() => hub.stateOf(clock).runs.find((entry: any) => entry.id === run)!.state === "cancelled");
    assert.equal(
      readFileSync(calls, "utf8")
        .split("\n")
        .filter((line) => line === "business").length,
      1,
    );
    assert.ok(!worker.entries().some((entry) => entry.run === run));
  },
);

test(
  "the real kernel retains a timed-out external turn until confirmation, then retries it as a failure",
  { skip: process.platform === "win32" },
  async () => {
    rmSync(available, { force: true });
    const before = readFileSync(calls, "utf8")
      .split("\n")
      .filter((line) => line === "business").length;
    let clock = Date.now() + 24 * 60 * 60_000;
    const worker = createWorker({
      name: "test",
      wait: 0,
      capacity: 1,
      now: () => clock,
      hub: {
        work: async (query) => {
          hub.heartbeat("test", query.running, clock);
          return {
            job: query.capacity ? hub.claimNext("test", query.claim, clock) : null,
            cancel: hub.cancels("test"),
          };
        },
        started: async (run, token, body) => hub.started(run, token, body, clock),
        result: async (run, token, body) => hub.finish(run, token, body, clock),
      },
    });
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, "worker did not settle");
        await worker.tick();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    hub.ingest("app", { id: "remote-timeout", type: "remote" }, clock);
    await until(
      () =>
        worker.entries().length > 0 &&
        readFileSync(calls, "utf8")
          .split("\n")
          .filter((line) => line === "business").length ===
          before + 1,
    );
    const run = worker.entries()[0].run;
    clock += 61_000;
    await until(
      () =>
        worker.entries().some((entry) => entry.unconfirmed !== undefined) ||
        hub.stateOf(clock).runs.find((entry) => entry.id === run)!.state !== "claimed",
    );
    assert.ok(
      worker.entries().some((entry) => entry.unconfirmed !== undefined),
      "unconfirmed timeout must retain its execution record",
    );
    clock += 6 * 60_000;
    await worker.tick();
    await until(() => worker.entries().some((entry) => entry.unconfirmed !== undefined));
    hub.sweep(clock);
    assert.equal(hub.stateOf(clock).runs.find((entry) => entry.id === run)!.state, "unknown");
    writeFileSync(available, "ready");
    clock += 61_000;
    await until(() => hub.stateOf(clock).runs.find((entry) => entry.id === run)!.state === "queued");
    assert.match(hub.stateOf(clock).runs.find((entry) => entry.id === run)!.error, /超过/);
    assert.equal(
      readFileSync(calls, "utf8")
        .split("\n")
        .filter((line) => line === "business").length,
      before + 1,
    );
  },
);
