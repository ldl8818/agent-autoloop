// Node's WebSocket needs TCP; the official proxy carries WebSocket bytes to the private daemon socket.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { commandLine } from "../../host/command.ts";

export async function connection(program: string) {
  let proxy: ReturnType<typeof spawn> | undefined;
  let socket: Duplex | undefined;
  let error = "";
  const capability = `/${randomUUID()}`;
  const relay = createServer((_request, response) => response.writeHead(404).end());
  relay.on("upgrade", (request, incoming, head) => {
    // An unauthenticated loopback listener would expose the daemon to other local users.
    if (request.url !== capability || socket) return incoming.destroy();
    socket = incoming;
    relay.close();
    const [executable, args] = commandLine([program, "app-server", "proxy"]);
    proxy = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    proxy.stderr!.on("data", (chunk) => (error = (error + chunk).slice(-4000)));
    proxy.on("error", (failure) => {
      error = failure.message;
      incoming.destroy();
    });
    proxy.on("exit", () => incoming.destroy());
    const headers = request.rawHeaders.reduce(
      (text, value, index, fields) => (index % 2 ? text : `${text}${value}: ${fields[index + 1]}\r\n`),
      "",
    );
    proxy.stdin!.write(`GET / HTTP/1.1\r\n${headers}\r\n`);
    if (head.length) proxy.stdin!.write(head);
    incoming.pipe(proxy.stdin!);
    proxy.stdout!.pipe(incoming);
    proxy.stdin!.on("error", () => incoming.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    relay.once("error", reject);
    relay.listen(0, "127.0.0.1", resolve);
  });
  const address = relay.address() as { port: number };
  return {
    url: `ws://127.0.0.1:${address.port}${capability}`,
    error: () => error,
    async close() {
      socket?.destroy();
      relay.close();
      if (proxy && proxy.exitCode === null && proxy.signalCode === null) {
        proxy.kill();
        await once(proxy, "exit");
      }
    },
  };
}
