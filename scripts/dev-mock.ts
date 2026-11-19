// 開發用：假後端（純 API，web/dev-mock.ts）＋ Vite 開發伺服器，Vite 把 /api 代理過去。
// 用法：bun run dev:mock，開 http://localhost:48765。WEB_PORT、MOCK_API_PORT 可以改埠；MOCK_FRESH=1 進初始設定。
const webPort = process.env.WEB_PORT ?? "48765";
const apiPort = process.env.MOCK_API_PORT ?? "48764";
const root = new URL("..", import.meta.url).pathname;

const children = [
  Bun.spawn(["bun", "web/dev-mock.ts"], { cwd: root, env: { ...process.env, PORT: apiPort, MOCK_ORIGIN: `http://localhost:${webPort}` }, stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "--bun", "vite"], { cwd: root, env: { ...process.env, WEB_PORT: webPort, API_URL: `http://127.0.0.1:${apiPort}` }, stdout: "inherit", stderr: "inherit" }),
];

const stop = () => {
  for (const c of children) c.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// 任何一個結束就一起結束，不留下孤兒程序
await Promise.race(children.map((c) => c.exited));
stop();
