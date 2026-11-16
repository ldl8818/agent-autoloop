// `agent-autoloop --version`: what someone pastes into a bug report. Failure cases: it needs an install to answer; code past a
// release still calls itself that release, as a number kept in a file does; a try-out tag beats the release on the same commit;
// a tag that isn't a version is taken for one; a commit whose ref has been packed away (what a clone comes to after a gc) reads
// as unknown, or a copy unpacked inside some other repository reads as that repository's commit or release.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { commitOf, releaseOf, versionLine, versionName } from "../host/version.ts";

const root = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-version-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

test("it prints this commit's release and the commit, with nothing installed", () => {
  const empty = join(dir, "nothing-installed");
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_AUTOLOOP_HOME: empty };
  delete env.AGENT_AUTOLOOP_COMMIT;
  delete env.AGENT_AUTOLOOP_RELEASE;
  const done = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(root, "bin", "agent-autoloop.ts"), "--version"],
    { env, encoding: "utf8" },
  );
  assert.equal(done.status, 0, done.stderr);
  const commit = git(root, "rev-parse", "HEAD").slice(0, 12);
  assert.equal(done.stdout.trim(), `agent-autoloop ${releaseOf(root) ?? "未发布"}（提交 ${commit}）`);
  assert.ok(!existsSync(empty), "asking the version sets nothing up");
});

test("the version is the tag on this commit, and only while it's on that commit", () => {
  const before = process.env.AGENT_AUTOLOOP_COMMIT;
  delete process.env.AGENT_AUTOLOOP_COMMIT;
  const release = process.env.AGENT_AUTOLOOP_RELEASE;
  delete process.env.AGENT_AUTOLOOP_RELEASE;
  const repo = join(dir, "tagged");
  mkdirSync(join(repo, "vendored"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "x");
  const head = git(repo, "rev-parse", "HEAD").slice(0, 12);
  assert.equal(releaseOf(repo), null);
  assert.equal(versionLine(repo), `agent-autoloop 未发布（提交 ${head}）`);
  assert.equal(versionName(repo), head, "what other programs are told still says which code this is");

  git(repo, "tag", "vendor-drop");
  assert.equal(releaseOf(repo), null, "a tag that isn't a version");
  git(repo, "tag", "v1.2.0-rc.1");
  assert.equal(releaseOf(repo), "v1.2.0-rc.1");
  git(repo, "tag", "v1.2.0");
  git(repo, "tag", "v1.2.0-rc.2");
  assert.equal(releaseOf(repo), "v1.2.0", "the release, not the try-outs that became it");
  assert.equal(versionLine(repo), `agent-autoloop v1.2.0（提交 ${head}）`);
  assert.equal(versionName(repo), "v1.2.0");
  assert.equal(releaseOf(join(repo, "vendored")), null, "a copy inside a repository isn't that repository's release");

  git(repo, "commit", "-q", "--allow-empty", "-m", "past it");
  assert.equal(releaseOf(repo), null, "past a release it isn't that release");
  assert.equal(releaseOf(join(dir, "no-such-folder")), null);
  if (before !== undefined) process.env.AGENT_AUTOLOOP_COMMIT = before;
  if (release !== undefined) process.env.AGENT_AUTOLOOP_RELEASE = release;
});

test("a commit reads the same whether its ref is a file or packed away, and a deployment's word counts", () => {
  const before = process.env.AGENT_AUTOLOOP_COMMIT;
  delete process.env.AGENT_AUTOLOOP_COMMIT;
  const clone = join(dir, "clone");
  mkdirSync(clone);
  git(clone, "init", "-q", "-b", "main");
  writeFileSync(join(clone, "file"), "x");
  git(clone, "add", "file");
  git(clone, "commit", "-qm", "x");
  const head = git(clone, "rev-parse", "HEAD");
  assert.equal(commitOf(clone), head);
  git(clone, "pack-refs", "--all");
  assert.ok(!existsSync(join(clone, ".git", "refs", "heads", "main")));
  assert.equal(commitOf(clone), head);

  mkdirSync(join(clone, "vendored"));
  assert.equal(commitOf(join(clone, "vendored")), "dev", "a copy inside a repository isn't at its commit");
  assert.equal(commitOf(join(dir, "no-such-folder")), "dev");

  process.env.AGENT_AUTOLOOP_COMMIT = "deployed";
  assert.equal(commitOf(clone), "deployed");
  if (before === undefined) delete process.env.AGENT_AUTOLOOP_COMMIT;
  else process.env.AGENT_AUTOLOOP_COMMIT = before;
});

test("an unpacked deployment says which release it is, from the environment it was started with", () => {
  const saved = { r: process.env.AGENT_AUTOLOOP_RELEASE, c: process.env.AGENT_AUTOLOOP_COMMIT };
  delete process.env.AGENT_AUTOLOOP_RELEASE;
  delete process.env.AGENT_AUTOLOOP_COMMIT;
  const tree = join(dir, "release-copy");
  mkdirSync(tree, { recursive: true });
  try {
    assert.equal(releaseOf(tree), null, "an unpacked copy has no tag of its own");
    assert.equal(versionLine(tree), "agent-autoloop 未发布（提交 dev）");
    assert.equal(versionName(tree), "dev");

    process.env.AGENT_AUTOLOOP_RELEASE = "v1.8.6";
    assert.equal(releaseOf(tree), "v1.8.6");
    assert.equal(versionLine(tree), "agent-autoloop v1.8.6（提交 dev）");
    assert.equal(versionName(tree), "v1.8.6", "what other programs are told still names the release");

    process.env.AGENT_AUTOLOOP_RELEASE = "not-a-version";
    assert.equal(releaseOf(tree), null, "a value that isn't a version is not taken for one");
    assert.equal(versionLine(tree), "agent-autoloop 未发布（提交 dev）");
  } finally {
    if (saved.r === undefined) delete process.env.AGENT_AUTOLOOP_RELEASE;
    else process.env.AGENT_AUTOLOOP_RELEASE = saved.r;
    if (saved.c === undefined) delete process.env.AGENT_AUTOLOOP_COMMIT;
    else process.env.AGENT_AUTOLOOP_COMMIT = saved.c;
  }
});
