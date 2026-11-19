// 影像硬體解碼／編碼的自我檢查：列出每張顯示卡，在每張卡上實際試跑 H.264／H.265 的解碼與編碼，
// 再用 detect worker 同一條指令（硬體解碼＋hwdownload＋縮圖）解一段影片。把整段輸出貼回來即可。
//   容器內：docker exec cookienvr video-selftest
//   原始碼目錄：bun scripts/video-selftest.ts [--ffmpeg /path/to/ffmpeg]
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectCommand } from "../src/detect/command.ts";
import { CODEC_LABEL, CODECS, explainHwFailure, sampleCommand, stderrTail } from "../src/hwcodec/commands.ts";
import { listVideoDevices } from "../src/hwcodec/devices.ts";
import { probeVideoDevices, spawnRunner } from "../src/hwcodec/probe.ts";
import { systemIo } from "../src/metrics/io.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const ffmpeg = arg("--ffmpeg") ?? process.env.FFMPEG_BIN ?? "ffmpeg";
const section = (title: string) => console.log(`\n===== ${title} =====`);
const sh = async (cmd: string[]) => {
  const r = await spawnRunner(cmd, {}, 10_000);
  return r.code === null && !r.timedOut ? `（無法執行：${r.stderr.trim()}）` : `${r.stdout}${r.stderr}`.trimEnd();
};

section("環境");
console.log(`平台 ${process.platform} ${process.arch}，Bun ${Bun.version}`);
console.log((await sh([ffmpeg, "-hide_banner", "-version"])).split("\n").slice(0, 3).join("\n"));
console.log(`ffmpeg -hwaccels：${(await sh([ffmpeg, "-hide_banner", "-hwaccels"])).split("\n").slice(1).join(" ").trim()}`);
const encoders = (await sh([ffmpeg, "-hide_banner", "-encoders"])).split("\n").filter((l) => /(vaapi|nvenc|qsv|videotoolbox)\b/.test(l)).map((l) => l.trim().split(/\s+/)[1]);
console.log(`硬體編碼器（編譯時有）：${encoders.join(" ") || "（沒有）"}`);
for (const k of ["NVIDIA_VISIBLE_DEVICES", "NVIDIA_DRIVER_CAPABILITIES", "CUDA_VISIBLE_DEVICES", "LIBVA_DRIVER_NAME"]) console.log(`${k}=${process.env[k] ?? "（未設定）"}`);
if (process.platform === "linux") {
  console.log(`/dev/dri：${((await systemIo.readDir("/dev/dri")) ?? ["（不存在）"]).join(" ")}`);
  console.log(`id：${await sh(["id"])}`);
  console.log(`VA 驅動：${((await systemIo.readDir("/usr/lib/x86_64-linux-gnu/dri")) ?? []).filter((n) => n.endsWith("_drv_video.so")).join(" ") || "（沒有）"}`);
}

section("找到的顯示卡");
const devices = await listVideoDevices(systemIo);
if (devices.length === 0) console.log("沒有找到（Linux 看 /sys/class/drm 的 Intel 卡與 nvidia-smi；macOS 是 VideoToolbox）");
for (const d of devices) console.log(`${d.id}  ${d.name}  ${JSON.stringify(d.api)}${d.pci ? `  PCI ${d.pci}` : ""}${d.blocked ? `\n  不能用：${d.blocked}` : ""}`);

section("試跑（每張卡 × 每種格式）");
const dir = await mkdtemp(join(tmpdir(), "video-selftest-"));
const report = await probeVideoDevices({ ffmpeg, io: systemIo, tmpDir: join(dir, "probe") });
const lines: string[] = [];
for (const d of report.devices) {
  for (const [label, set] of [["解碼", d.decode], ["編碼", d.encode]] as const) {
    for (const c of CODECS) {
      const r = set[c];
      const line = `${d.id} ${CODEC_LABEL[c]} ${label}：${r.ok ? `成功（${r.ms} ms）` : `失敗：${r.reason}`}`;
      lines.push(line);
      console.log(line);
      if (!r.ok) console.log(r.detail.split("\n").map((l) => `    > ${l}`).join("\n"));
    }
  }
}

section("detect worker 的實際指令（硬體解碼 3 秒影片）");
try {
  for (const codec of CODECS) {
    const sample = join(dir, `long-${codec}.mp4`);
    const gen = sampleCommand(ffmpeg, codec, sample).map((a) => (a === "10" ? "30" : a));
    if ((await spawnRunner(gen, {}, 30_000)).code !== 0) {
      console.log(`${CODEC_LABEL[codec]}：產生不了測試影片，略過`);
      continue;
    }
    for (const d of devices.filter((x) => !x.blocked && report.devices.find((p) => p.id === x.id)?.decode[codec].ok)) {
      const { cmd, env } = detectCommand(ffmpeg, sample, 1, { deviceId: d.id, name: d.name, codec, api: d.api });
      // 和 worker 一模一樣，只拿掉 RTSP 專用的參數，兩路輸出寫到 /dev/null
      const rtspOnly = new Set(["-rtsp_transport", "-timeout"]);
      const args = cmd.filter((a, i) => !rtspOnly.has(a) && !rtspOnly.has(cmd[i - 1]!)).map((a) => (a === "pipe:1" || a === "pipe:3" ? "/dev/null" : a));
      const r = await spawnRunner([args[0]!, "-y", ...args.slice(1)], env, 30_000);
      const verdict = r.code === 0 ? `成功（${r.ms} ms）` : `失敗：${explainHwFailure(d.api, `${CODEC_LABEL[codec]} 硬體解碼`, r.stderr, { timedOut: r.timedOut, exitCode: r.code }).reason}`;
      lines.push(`${d.id} detect 指令 ${CODEC_LABEL[codec]}：${verdict}`);
      console.log(`${d.id} ${CODEC_LABEL[codec]}：${verdict}`);
      if (r.code !== 0) console.log(stderrTail(r.stderr).split("\n").map((l) => `    > ${l}`).join("\n"));
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

section("摘要（可直接貼給 AI）");
console.log(`ffmpeg：${report.ffmpeg}`);
console.log(lines.length ? lines.join("\n") : "沒有可試跑的顯示卡");
