#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const extension = fileURLToPath(new URL("./index.ts", import.meta.url));
const [initial, ...args] = process.argv.slice(2);
const hosts = new Set(["pi", "pig"]);
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

async function executable(host, cwd) {
	const override = process.env[`PI_SWITCH_${host.toUpperCase()}_BIN`];
	if (override && !isAbsolute(override)) throw new Error(`PI_SWITCH_${host.toUpperCase()}_BIN must be an absolute path.`);
	const candidates = override ? [resolve(override)] : (process.env.PATH || "").split(delimiter).map((dir) => resolve(cwd, dir, host));
	for (const candidate of candidates) {
		try {
			await access(candidate, constants.X_OK);
			if ((await stat(candidate)).isFile()) return await realpath(candidate);
		} catch { /* Try the next PATH entry. */ }
	}
	throw new Error(`Cannot find executable ${host}. Install it or set PI_SWITCH_${host.toUpperCase()}_BIN.`);
}

function environment(host, socket, token, expected) {
	const env = { ...process.env };
	// PiG extension transport addresses belong to the outgoing host, never its successor.
	for (const key of Object.keys(env)) {
		if (key.startsWith("PI_SWITCH_") && !key.endsWith("_BIN") || key.startsWith("PIG_EXT_SOCKET")) delete env[key];
	}
	Object.assign(env, { PI_SWITCH_HOST: host, PI_SWITCH_SOCKET: socket, PI_SWITCH_TOKEN: token });
	if (expected) env.PI_SWITCH_EXPECTED = JSON.stringify(expected);
	return env;
}

async function main() {
	if (!hosts.has(initial)) throw new Error("Usage: pi-switch <pi|pig> [arguments...]");
	if (process.platform === "win32") throw new Error("pi-switch currently supports macOS and Linux only.");
	let host = initial;
	let cwd = process.cwd();
	let command = await executable(host, cwd);
	let hostArgs = args;
	const management = new Set(["install", "remove", "uninstall", "update", "list", "config", "auth", "mcp", "login", "logout", "piglet", "package", "extension", "reload", "setup", "verify", "status", "docs", "version", "diagnose"]);
	if (management.has(args[0])) {
		return await new Promise((resolve, reject) => {
			const process = spawn(command, args, { cwd, stdio: "inherit" });
			process.once("error", reject);
			process.once("exit", (code) => resolve(code ?? 1));
		});
	}
	let expected;
	const directory = await mkdtemp(join(tmpdir(), "pi-switch-"));
	await chmod(directory, 0o700);
	const socketPath = join(directory, "control.sock");
	let token;
	let pending;
	let ready = false;
	let child;
	let interrupted = false;
	const sockets = new Set();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		socket.setTimeout(3000, () => socket.destroy());
		let data = "";
		let handled = false;
		socket.on("data", async (chunk) => {
			if (handled) return;
			data += chunk.toString();
			if (data.length > 65536) return socket.destroy();
			if (!data.includes("\n")) return;
			handled = true;
			try {
				const message = JSON.parse(data.slice(0, data.indexOf("\n")));
				if (message.token !== token || !child || child.exitCode !== null || child.signalCode !== null) throw new Error("Expired launcher connection.");
				if (message.action === "ready") {
					ready = true;
				} else if (message.action === "commit") {
					if (!pending || Date.now() > pending.expires) throw new Error("Switch request expired.");
					if (typeof message.leaf !== "string" || !message.leaf) throw new Error("Missing persisted handoff entry.");
					pending.leaf = message.leaf;
					pending.committed = true;
				} else if (message.action === "cancel") {
					pending = undefined;
				} else if (message.action === "switch") {
					if (pending) throw new Error("A switch is already pending.");
					if (!hosts.has(message.target) || message.target === host) throw new Error("Invalid switch target.");
					if (typeof message.id !== "string" || !/^[a-zA-Z0-9-]+$/.test(message.id)) throw new Error("Invalid session ID.");
					if (typeof message.file !== "string" || !isAbsolute(message.file) || !(await stat(message.file)).isFile()) throw new Error("Session file is unavailable.");
					if (typeof message.cwd !== "string" || !isAbsolute(message.cwd) || !(await stat(message.cwd)).isDirectory()) throw new Error("Working directory is unavailable.");
					if (message.leaf !== null && typeof message.leaf !== "string") throw new Error("Invalid session leaf.");
					const nextCommand = await executable(message.target, message.cwd);
					if (message.token !== token || !child || child.exitCode !== null || child.signalCode !== null || pending) throw new Error("Switch request expired.");
					pending = { ...message, command: nextCommand, committed: false, expires: Date.now() + 15000 };
				} else throw new Error("Unknown launcher request.");
				socket.end(JSON.stringify({ ok: true }) + "\n");
			} catch (error) {
				socket.end(JSON.stringify({ ok: false, error: error.message }) + "\n");
			}
		});
	});
	const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
	const handlers = signals.map((signal) => {
		const handler = () => { interrupted = true; pending = undefined; child?.kill(signal); };
		process.on(signal, handler);
		return handler;
	});
	try {
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, resolve);
		});
		while (true) {
			token = randomUUID();
			pending = undefined;
			ready = false;
			let result;
			try {
				result = await new Promise((resolve, reject) => {
					child = spawn(command, ["-e", extension, ...hostArgs], {
						cwd, env: environment(host, socketPath, token, expected), stdio: "inherit",
					});
					child.once("error", reject);
					child.once("exit", (code, signal) => resolve({ code, signal }));
				});
			} catch (error) {
				console.error(`pi-switch: ${error.message}`);
				result = { code: 1 };
			}
			child = undefined;
			if (expected && !ready) {
				console.error(`pi-switch: Target did not confirm the same session and branch.\nRecover: cd ${quote(cwd)} && ${quote(expected.sourceCommand)} --session ${quote(expected.id)}`);
				return 1;
			}
			if (interrupted || result.signal || result.code !== 0 || !pending?.committed) {
				if (pending) console.error(`pi-switch: Shutdown did not complete the handoff; the target was not started.\nRecover: cd ${quote(cwd)} && ${quote(command)} --session ${quote(pending.id)}`);
				if (result.code) return result.code;
				if (result.signal === "SIGINT") return 130;
				return result.signal || pending ? 1 : 0;
			}
			const next = pending;
			expected = { id: next.id, file: next.file, leaf: next.leaf, sourceCommand: command };
			host = next.target;
			command = next.command;
			cwd = next.cwd;
			hostArgs = ["--session", next.id];
		}
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise((resolve) => server.close(resolve));
		signals.forEach((signal, index) => process.removeListener(signal, handlers[index]));
		await rm(directory, { recursive: true, force: true });
	}
}

try { process.exitCode = await main(); }
catch (error) { console.error(`pi-switch: ${error.message}`); process.exitCode = 1; }
