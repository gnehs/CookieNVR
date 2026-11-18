// 模擬 Tapo：獨立的 MediaMTX 加上兩個 ffmpeg 推 testsrc，路徑 /stream1（高解析度）與 /stream2（低解析度）。
// 用法：bun scripts/fake-camera.ts --port 28555 [--user NAME --pass SECRET] [--ffmpeg ffmpeg] [--mediamtx mediamtx]
// mediamtx 內建帳密只接受 A-Z 0-9 與 !$()*+.;<=>[]^_-,@#& 這些字元（: / ? 不行）。
// 兩條串流都上線後，stdout 會印出一行 "READY rtsp://127.0.0.1:<port>"。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "28555" },
    user: { type: "string" },
    pass: { type: "string" },
    ffmpeg: { type: "string", default: "ffmpeg" },
    mediamtx: { type: "string", default: "mediamtx" },
  },
});

const port = Number(values.port);
const { user, pass } = values;
if ((user === undefined) !== (pass === undefined)) {
  console.error("--user 與 --pass 要一起給");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "fake-camera-"));
const confPath = join(dir, "mediamtx.yml");

const readUser =
  user === undefined
    ? `  - user: any\n    pass:\n    permissions:\n      - action: read\n`
    : `  - user: ${JSON.stringify(user)}\n    pass: ${JSON.stringify(pass)}\n    permissions:\n      - action: read\n`;

// ffmpeg 從本機免帳密推流；對外讀取才需要帳密
writeFileSync(
  confPath,
  `logLevel: info
api: false
metrics: false
pprof: false
playback: false
rtmp: false
hls: false
webrtc: false
srt: false
moq: false
rtspTransports: [tcp]
rtspAddress: :${port}
authInternalUsers:
  - user: any
    pass:
    ips: ["127.0.0.1", "::1"]
    permissions:
      - action: publish
${readUser}paths:
  stream1:
  stream2:
`,
);

const children = new Set<Bun.Subprocess>();
let stopping = false;
const online = new Set<string>();

function stop(code: number): never {
  stopping = true;
  for (const c of children) c.kill("SIGTERM");
  rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

const mtx = Bun.spawn([values.mediamtx!, confPath], { stdout: "pipe", stderr: "inherit" });
children.add(mtx);
void mtx.exited.then((code) => {
  if (!stopping) {
    console.error(`mediamtx 非預期結束（${code}）`);
    stop(1);
  }
});

void (async () => {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of mtx.stdout) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const m = /\[path (stream[12])\] stream is available/.exec(line);
      if (m?.[1] && !online.has(m[1])) {
        online.add(m[1]);
        if (online.size === 2) console.log(`READY rtsp://127.0.0.1:${port}`);
      }
    }
  }
})();

function publish(name: string, video: string, rate: number, bitrate: string) {
  const args = [
    values.ffmpeg!, "-hide_banner", "-loglevel", "error", "-re",
    "-f", "lavfi", "-i", `testsrc2=size=${video}:rate=${rate}`,
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000",
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
    "-pix_fmt", "yuv420p", "-g", String(rate * 2), "-b:v", bitrate,
    "-c:a", "pcm_alaw", "-ar", "8000", "-ac", "1",
    "-f", "rtsp", "-rtsp_transport", "tcp", `rtsp://127.0.0.1:${port}/${name}`,
  ];
  const run = async () => {
    while (!stopping) {
      const p = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
      children.add(p);
      await p.exited;
      children.delete(p);
      if (!stopping) await Bun.sleep(500);
    }
  };
  void run();
}

publish("stream1", "1920x1080", 15, "2M");
publish("stream2", "640x360", 10, "300k");
