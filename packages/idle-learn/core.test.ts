import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, linkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { CONFIG_PATH, initializeConfig, loadConfig, parseConfig, requireOptIn, saveConfig, serializeConfig } from "./config.ts";
import { atomicProjectWrite, contentHash, MAX_FILE_BYTES, projectPath, projectRoot, readProjectFile, targetPath } from "./files.ts";

const directories: string[] = [];
function fixture(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "idle-learn-")));
	directories.push(root);
	return root;
}
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("missing opt-in reads and failed operations create no files", () => {
	const root = fixture();
	assert.deepEqual(loadConfig(root), { status: "missing", enabled: false });
	assert.throws(() => requireOptIn(root), /init/);
	assert.deepEqual(readdirSync(root), []);
});

test("init creates defaults and never overwrites an existing configuration", () => {
	const root = fixture();
	assert.deepEqual(initializeConfig(root), { enabled: true, idle_minutes: 10 });
	const before = readFileSync(join(root, CONFIG_PATH), "utf8");
	assert.throws(() => initializeConfig(root), /changed|EEXIST/);
	assert.equal(readFileSync(join(root, CONFIG_PATH), "utf8"), before);
	assert.deepEqual(readdirSync(join(root, ".pi/idle-learn")), ["config.toml"]);
});

test("TOML comments, strings, and optional defaults round trip", () => {
	const config = parseConfig(`enabled = true # opt in\nprovider = 'example'\nmodel = "model#one"\nprompt_file = "reviewer.md"\nappend_file = 'extra.md'\nthinking = 'high'\n`);
	assert.equal(config.idle_minutes, 10);
	assert.equal(config.model, "model#one");
	assert.deepEqual(parseConfig(serializeConfig(config)), config);
});

test("malformed and unsupported configuration fails closed", () => {
	for (const text of [
		"", "enabled = 'true'", "enabled = true\nenabled = false", "enabled = true\nunknown = 1",
		"enabled = true\nidle_minutes = 0", "enabled = true\nidle_minutes = 1.5",
		"enabled = true\nidle_minutes = 1441", "enabled = true\nprovider = 'example'",
		"enabled = true\nmodel = 'example'", "enabled = true\nthinking = 'extreme'",
		"enabled = true\nprompt_file = ''", "enabled = true\n[extra]\nx = 1",
	]) {
		assert.throws(() => parseConfig(text), Error, text);
	}
	const root = fixture();
	initializeConfig(root);
	writeFileSync(join(root, CONFIG_PATH), "not toml");
	const result = loadConfig(root);
	assert.equal(result.status, "invalid");
	assert.equal(result.enabled, false);
	assert.throws(() => requireOptIn(root, true), /Fix/);
});

test("pause preserves configuration and allows review, but not new analysis", () => {
	const root = fixture();
	initializeConfig(root);
	const before = readFileSync(join(root, CONFIG_PATH), "utf8");
	saveConfig(root, { enabled: false, idle_minutes: 15 }, before);
	assert.equal(loadConfig(root).enabled, false);
	assert.throws(() => requireOptIn(root), /paused/);
	assert.equal(requireOptIn(root, true).idle_minutes, 15);
	assert.throws(() => saveConfig(root, { enabled: true, idle_minutes: 20 }, before), /changed/);
	assert.equal(requireOptIn(root, true).idle_minutes, 15);
});

test("invalid configuration never replaces working configuration", () => {
	const root = fixture();
	initializeConfig(root);
	const before = readFileSync(join(root, CONFIG_PATH), "utf8");
	assert.throws(() => saveConfig(root, { enabled: true, idle_minutes: -1 }, before));
	assert.equal(readFileSync(join(root, CONFIG_PATH), "utf8"), before);
});

test("outside Git, opt-in does not search parent directories", () => {
	const root = fixture();
	initializeConfig(root);
	const child = join(root, "child");
	mkdirSync(child);
	assert.equal(projectRoot(child), child);
	assert.equal(loadConfig(child).status, "missing");
});

test("Git roots respect worktrees instead of the main checkout", () => {
	const directory = fixture();
	const main = join(directory, "main");
	const worktree = join(directory, "worktree");
	mkdirSync(main);
	execFileSync("git", ["init", "-q", main]);
	execFileSync("git", ["-C", main, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--allow-empty", "-qm", "initial"]);
	execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", "test-worktree", worktree]);
	const nested = join(worktree, "nested");
	mkdirSync(nested);
	assert.equal(projectRoot(nested), projectRoot(worktree));
	assert.notEqual(projectRoot(nested), projectRoot(main));
});

test("only project-relative AGENTS.md targets are accepted", () => {
	const root = fixture();
	for (const path of ["../AGENTS.md", "/tmp/AGENTS.md", "a/../AGENTS.md", "./AGENTS.md", "a//AGENTS.md", "a\\AGENTS.md", ".git/AGENTS.md", ".GIT/AGENTS.md", "CLAUDE.md", "foo.ts", ".pi/idle-learn/AGENTS.md"]) {
		assert.throws(() => targetPath(root, path), Error, path);
	}
	assert.equal(targetPath(root, "AGENTS.md"), join(root, "AGENTS.md"));
	assert.equal(targetPath(root, "nested/AGENTS.md"), join(root, "nested/AGENTS.md"));
});

test("symlink files, parents, and hard-linked evidence are rejected", () => {
	const root = fixture();
	const outside = fixture();
	writeFileSync(join(outside, "AGENTS.md"), "private");
	symlinkSync(outside, join(root, "linked"));
	symlinkSync(join(outside, "AGENTS.md"), join(root, "AGENTS.md"));
	assert.throws(() => targetPath(root, "linked/AGENTS.md"), /symlink/);
	assert.throws(() => readProjectFile(root, "AGENTS.md"), /symlink/);
	assert.throws(() => atomicProjectWrite(root, "linked/AGENTS.md", "bad", "private"), /symlink/);
	linkSync(join(outside, "AGENTS.md"), join(root, "hardlink"));
	assert.throws(() => readProjectFile(root, "hardlink"), /regular/);
	assert.equal(readFileSync(join(outside, "AGENTS.md"), "utf8"), "private");
});

test("configuration symlinks fail closed without touching their destinations", () => {
	const root = fixture();
	const outside = fixture();
	symlinkSync(outside, join(root, ".pi"));
	assert.equal(loadConfig(root).status, "invalid");
	assert.throws(() => initializeConfig(root), /symlink/);
	assert.deepEqual(readdirSync(outside), []);
});

test("bounded reads reject directories, oversized files, and invalid UTF-8", () => {
	const root = fixture();
	assert.throws(() => readProjectFile(root, "missing\0name"));
	mkdirSync(join(root, "folder"));
	assert.throws(() => readProjectFile(root, "folder"), /regular/);
	writeFileSync(join(root, "large"), "x".repeat(MAX_FILE_BYTES + 1));
	assert.throws(() => readProjectFile(root, "large"), /exceeds/);
	writeFileSync(join(root, "invalid"), Buffer.from([0xff]));
	assert.throws(() => readProjectFile(root, "invalid"));
	assert.equal(readProjectFile(root, "absent"), null);
});

test("atomic writes create nested files, check current content, and clean temporary files", () => {
	const root = fixture();
	atomicProjectWrite(root, "folder/AGENTS.md", "first", null);
	assert.equal(readProjectFile(root, "folder/AGENTS.md"), "first");
	atomicProjectWrite(root, "folder/AGENTS.md", "second", "first");
	assert.equal(readProjectFile(root, "folder/AGENTS.md"), "second");
	assert.throws(() => atomicProjectWrite(root, "folder/AGENTS.md", "stale", "first"), /changed/);
	assert.equal(readProjectFile(root, "folder/AGENTS.md"), "second");
	assert.deepEqual(readdirSync(join(root, "folder")), ["AGENTS.md"]);
	assert.throws(() => atomicProjectWrite(root, "large", "x".repeat(MAX_FILE_BYTES + 1), null), /exceeds/);
	assert.equal(existsSync(join(root, "large")), false);
	assert.equal(contentHash("same"), contentHash("same"));
	assert.notEqual(contentHash("same"), contentHash("different"));
});
