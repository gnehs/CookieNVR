// 對實機做唯讀擷取，把回應去識別化後存成測試 fixture。
// 用法：bun src/onvif/fixtures/capture.ts --env .env.tapo --out src/onvif/fixtures/tapo [--port 2020] [--pull-seconds 60]
// 只送不改變相機狀態的請求；不送任何 PTZ 移動或預置點寫入。
import { parseArgs } from "node:util";
import { OnvifClient } from "../client.ts";
import { isOnvifError } from "../errors.ts";
import { createPullPoint, pullMessages, renew, unsubscribe } from "../events.ts";
import { getPresets } from "../ptz.ts";
import { NS } from "../soap.ts";

const { values } = parseArgs({
  options: {
    env: { type: "string" },
    out: { type: "string" },
    port: { type: "string", default: "2020" },
    "pull-seconds": { type: "string", default: "60" },
  },
});
if (!values.env || !values.out) throw new Error("需要 --env 與 --out");

const vars = Object.fromEntries(
  (await Bun.file(values.env).text())
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
const endpoint = { host: vars.TAPO_HOST ?? "", port: Number(values.port), username: vars.TAPO_USER ?? "", password: vars.TAPO_PASS ?? "" };
if (!endpoint.host || !endpoint.username || !endpoint.password) throw new Error("env 檔缺少 TAPO_HOST、TAPO_USER 或 TAPO_PASS");

function redact(xml: string, secrets: string[]): string {
  let out = xml
    .replace(/\b(?!0\.0\.0\.0\b)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, "192.0.2.10")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "00000000-0000-0000-0000-000000000000")
    .replace(/\b([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g, "00:00:00:00:00:00")
    .replace(/(<(?:\w+:)?(?:SerialNumber|HardwareId)>)[^<]*/g, "$1REDACTED");
  for (const s of secrets) if (s) out = out.split(s).join("REDACTED");
  return out;
}

const secrets = [endpoint.host, endpoint.username, endpoint.password];
const captured: { name: string; xml: string }[] = [];
const recordingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const res = await fetch(input, init);
  const xml = await res.text();
  const action = /action="[^"]*\/([^"/]+?)(?:Request)?"/.exec(String((init?.headers as Record<string, string>)?.["Content-Type"]))?.[1] ?? "unknown";
  captured.push({ name: action, xml });
  return new Response(xml, { status: res.status, headers: res.headers });
}) as typeof fetch;

const save = async (file: string, xml: string) => {
  const clean = redact(xml, secrets);
  for (const s of secrets) if (clean.includes(s)) throw new Error(`${file} 去識別化失敗`);
  await Bun.write(`${values.out}/${file}.xml`, clean);
  console.log(`已存 ${file}.xml`);
};
const last = (name: string) => [...captured].reverse().find((c) => c.name === name)?.xml;

const client = new OnvifClient(endpoint, { fetch: recordingFetch });
const caps = await client.capabilities();
await client
  .callUrl(client.deviceUrl, `${NS.tds}/GetServices`, "GetServices", `<GetServices xmlns="${NS.tds}"><IncludeCapability>true</IncludeCapability></GetServices>`)
  .catch(() => {});
if (caps.ptz) await getPresets(client);
if (caps.events) {
  await client.call("events", `${NS.tev}/EventPortType/GetEventPropertiesRequest`, "GetEventProperties", `<GetEventProperties xmlns="${NS.tev}"/>`, { addressing: true });
  const sub = await createPullPoint(client, { terminationSeconds: 60 });
  const until = Date.now() + Number(values["pull-seconds"]) * 1000;
  let renewed = false;
  while (Date.now() < until) {
    const res = await pullMessages(client, sub, { timeoutSeconds: 10 });
    for (const e of res.events) console.log("事件", e.kind, e.topic, e.active);
    if (res.events.length) await save(`PullMessages-events-${captured.length}`, last("PullMessages")!);
    if (!renewed) {
      sub.terminationAt = await renew(client, sub, 60);
      renewed = true;
    }
  }
  await unsubscribe(client, sub);
}
const bad = new OnvifClient({ ...endpoint, password: `${endpoint.password}-wrong` }, { fetch: recordingFetch });
await bad.capabilities().catch((err) => {
  if (!isOnvifError(err, "auth")) throw err;
});

for (const name of ["GetSystemDateAndTime", "GetCapabilities", "GetServices", "GetProfiles", "GetNodes", "GetPresets", "GetEventProperties", "CreatePullPointSubscription", "PullMessages", "Renew", "Unsubscribe"]) {
  const xml = captured.find((c) => c.name === name)?.xml;
  if (xml) await save(name, xml);
}
const fault = last("GetProfiles");
if (fault?.includes("NotAuthorized")) await save("Fault-NotAuthorized", fault);
console.log(JSON.stringify({ ptz: caps.ptz, events: caps.events, clockOffsetMs: client.clockOffsetMs }));
