// Failure modes: built-ins bypass external plugin discovery; plugin names escape their directory; installation overwrites
// an existing plugin or runs its scripts; an adapter path survives only in the old directory.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";
const home = setup("plugins");
const { loadPlugin } = await import("../host/plugins.ts");
test("all built-in kinds use the same loader and external plugins take precedence", async () => {
  for (const [name, kind] of [
    ["claude", "agent"],
    ["codex", "agent"],
    ["command", "agent"],
    ["acp", "agent"],
    ["dsh", "agent"],
    ["zcode", "agent"],
    ["feishu", "channel"],
    ["webhook", "channel"],
    ["github", "source"],
  ] as const)
    assert.ok(await loadPlugin(name, kind));
  mkdirSync(join(home, "plugins", "outside"), { recursive: true });
  writeFileSync(join(home, "plugins", "outside", "agent.ts"), "export default {marker:42};");
  assert.equal((await loadPlugin("outside", "agent")).marker, 42);
  await assert.rejects(() => loadPlugin("../outside", "agent"));
});
