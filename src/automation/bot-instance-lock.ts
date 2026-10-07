import { createServer, type Server } from "node:net";

// A kernel-owned loopback listener releases automatically on exit/crash;
// unlike a PID file, it cannot be stolen by two concurrent stale-lock cleaners.
export async function acquireBotInstanceLock(port = 17455): Promise<Server> {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => reject(new Error(
      error.code === "EADDRINUSE"
        ? `机器人单实例锁 ${port} 已被占用，本次拒绝启动第二实例`
        : `机器人单实例锁失败：${error.code ?? error.name}`,
    )));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  server.unref();
  return server;
}
