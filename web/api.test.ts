import { afterEach, describe, expect, mock, test } from "bun:test";
import { api } from "./api.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function captureUrls(): string[] {
  const urls: string[] = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return Response.json([]);
  }) as unknown as typeof fetch;
  return urls;
}

// 播放器的時間由影片 currentTime 換算，常帶小數；伺服器只收整數毫秒，帶小數會回 400、錄影整個載不出來
describe("time ranges sent to the server are whole milliseconds", () => {
  test("recordings widens a fractional range outward", async () => {
    const urls = captureUrls();
    await api.recordings("cam1", 1000.6, 2000.2);
    expect(urls).toEqual(["/api/cameras/cam1/recordings?start=1000&end=2001"]);
  });

  test("events and active events do the same", async () => {
    const urls = captureUrls();
    await api.events("cam1", 1000.6, 2000.2);
    await api.activeEvents(1000.6, 2000.2);
    expect(urls).toEqual(["/api/events?camera=cam1&start=1000&end=2001", "/api/events?start=1000&end=2001"]);
  });

  test("eventsBefore rounds its cutoff", async () => {
    const urls = captureUrls();
    await api.eventsBefore(2000.2, 10, null);
    expect(urls).toEqual(["/api/events?before=2001&limit=10"]);
  });
});
