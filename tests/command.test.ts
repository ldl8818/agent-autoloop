// Failure modes: a blank entry in PATH, which a trailing `;` leaves behind, makes the current folder a place findOnPath
// searches — so a project holding its own `tool.exe` answers for `tool`, and that program runs in place of the installed one.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { findOnPath } from "../host/command.ts";

const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-command-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// A blank entry names whatever folder the process is in, so the planted program has to sit in the one the test runs from.
test("a blank PATH entry doesn't make the current folder a place to look", () => {
  const project = join(scratch, "project");
  mkdirSync(project);
  writeFileSync(join(project, "planted.exe"), "");
  const here = process.cwd();
  const path = process.env.PATH;
  try {
    process.chdir(project);
    process.env.PATH = ";";
    assert.equal(findOnPath("planted"), null, "a blank PATH entry searched the current folder");
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    process.chdir(here);
  }
});
