/**
 * 能力偵測：在每張卡上實際試跑每種編碼格式的解碼與編碼。只看 `ffmpeg -hwaccels` 不夠：
 * 映像裡的 ffmpeg 編譯時都有支援，但容器裡缺驅動、沒掛裝置節點、或卡太舊時一樣用不了。
 */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { msg, type Msg } from "../messages/index.ts";
import type { MetricsIo } from "../metrics/io.ts";
import { CODEC_LABEL, CODECS, decodeTestCommand, encodeTestCommand, explainHwFailure, hwEnv, hwFailure, sampleCommand, stderrTail, type CodecName, type HwWhat } from "./commands.ts";
import { listVideoDevices, type VideoDevice } from "./devices.ts";

export type CodecCheck = { ok: true; ms: number } | { ok: false; reason: string; detail: string; reasonMsg: Msg };

export interface ProbedDevice extends VideoDevice {
  decode: Record<CodecName, CodecCheck>;
  encode: Record<CodecName, CodecCheck>;
}

export interface ProbeReport {
  at: number;
  /** `ffmpeg -version` 的第一行 */
  ffmpeg: string;
  devices: ProbedDevice[];
}

export interface RunOutcome {
  code: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
  ms: number;
}

export type Runner = (cmd: string[], env: Record<string, string>, timeoutMs: number) => Promise<RunOutcome>;

export const spawnRunner: Runner = async (cmd, env, timeoutMs) => {
  const started = performance.now();
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  } catch (e) {
    return { code: null, stderr: (e as Error).message, stdout: "", timedOut: false, ms: 0 };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text(), proc.exited]);
  clearTimeout(timer);
  return { code: timedOut ? null : code, stderr, stdout, timedOut, ms: Math.round(performance.now() - started) };
};

export interface ProbeDeps {
  ffmpeg: string;
  io: MetricsIo;
  /** 試跑短片放這裡，跑完刪掉 */
  tmpDir: string;
  run?: Runner;
  now?: () => number;
  timeoutMs?: number;
}

const TIMEOUT_MS = 15_000;

function check(r: RunOutcome, device: VideoDevice, what: HwWhat): CodecCheck {
  if (r.code === 0 && !r.timedOut) return { ok: true, ms: r.ms };
  return { ok: false, ...explainHwFailure(device.api, what, r.stderr, { timedOut: r.timedOut, exitCode: r.code }) };
}

const blocked = (reasonMsg: Msg): CodecCheck => ({ ok: false, ...hwFailure(reasonMsg, "device node missing") });
const each = <T>(fn: (c: CodecName) => T) => Object.fromEntries(CODECS.map((c) => [c, fn(c)])) as Record<CodecName, T>;

export async function probeVideoDevices(deps: ProbeDeps): Promise<ProbeReport> {
  const run = deps.run ?? spawnRunner;
  const timeout = deps.timeoutMs ?? TIMEOUT_MS;
  const at = (deps.now ?? Date.now)();
  const [devices, version] = await Promise.all([listVideoDevices(deps.io), run([deps.ffmpeg, "-hide_banner", "-version"], {}, 5_000)]);
  const ffmpeg = version.stdout.split("\n")[0]?.trim() || stderrTail(version.stderr, 1) || "（無法執行 ffmpeg）";
  if (devices.length === 0) return { at, ffmpeg, devices: [] };

  await mkdir(deps.tmpDir, { recursive: true });
  try {
    const samples = await Promise.all(
      CODECS.map(async (codec) => {
        const path = join(deps.tmpDir, `sample-${codec}.mp4`);
        const r = await run(sampleCommand(deps.ffmpeg, codec, path), {}, timeout);
        const failure: CodecCheck | null = r.code === 0 ? null : { ok: false, ...hwFailure(msg("hw.sampleFailed", { codec: CODEC_LABEL[codec] }), stderrTail(r.stderr)) };
        return [codec, { path, failure }] as const;
      }),
    );
    const sample = Object.fromEntries(samples) as Record<CodecName, { path: string; failure: CodecCheck | null }>;

    const probed = await Promise.all(
      devices.map(async (d): Promise<ProbedDevice> => {
        if (d.blocked) return { ...d, decode: each(() => blocked(d.blocked!)), encode: each(() => blocked(d.blocked!)) };
        const env = hwEnv(d.api);
        // 同一張卡上依序跑，不讓四個試跑互相搶同一個引擎而逾時
        const decode = {} as Record<CodecName, CodecCheck>;
        const encode = {} as Record<CodecName, CodecCheck>;
        for (const codec of CODECS) {
          const s = sample[codec];
          decode[codec] = s.failure ?? check(await run(decodeTestCommand(deps.ffmpeg, d.api, s.path), env, timeout), d, { codec, op: "decode" });
        }
        for (const codec of CODECS) encode[codec] = check(await run(encodeTestCommand(deps.ffmpeg, d.api, codec), env, timeout), d, { codec, op: "encode" });
        return { ...d, decode, encode };
      }),
    );
    return { at, ffmpeg, devices: probed };
  } finally {
    await rm(deps.tmpDir, { recursive: true, force: true });
  }
}
