import { createConnection } from "node:net";

export function request(message: Record<string, unknown>): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(process.env.PI_SWITCH_SOCKET!);
		let data = "";
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			socket.destroy();
			if (error) reject(error);
			else resolve();
		};
		socket.setTimeout(3000, () => finish(new Error("The pi-switch launcher did not respond.")));
		socket.on("error", finish);
		socket.on("end", () => finish(new Error("The pi-switch launcher closed the connection.")));
		socket.on("connect", () => socket.write(JSON.stringify({ ...message, token: process.env.PI_SWITCH_TOKEN }) + "\n"));
		socket.on("data", (chunk) => {
			data += chunk.toString();
			if (data.length > 8192) return finish(new Error("Invalid launcher response."));
			if (!data.includes("\n")) return;
			try {
				const response = JSON.parse(data.slice(0, data.indexOf("\n")));
				finish(response.ok === true ? undefined : new Error(response.error || "Switch refused."));
			} catch { finish(new Error("Invalid launcher response.")); }
		});
	});
}
