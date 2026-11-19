import { expect, test } from "bun:test";
import { Prebuffer } from "./fragments";

const frag = (tag: number, durationMs = 2000) => ({ bytes: new Uint8Array([tag]), durationMs });
const tags = async (s: { next(): Promise<Uint8Array | null> }, n: number) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await s.next())![0]!);
  return out;
};

test("keeps the newest fragments that cover the prebuffer length", () => {
  const p = new Prebuffer(4000);
  p.setInit(new Uint8Array([0]));
  for (let i = 1; i <= 5; i++) p.push(frag(i));
  expect(p.bufferedMs).toBe(4000);
  p.push(frag(6, 1000));
  // 5 (2 s) + 6 (1 s) is short of 4 s, so 4 stays.
  expect(p.bufferedMs).toBe(5000);
});

test("a stream sends init, then the prebuffer, then live fragments in order", async () => {
  const p = new Prebuffer(4000);
  p.setInit(new Uint8Array([0]));
  for (let i = 1; i <= 4; i++) p.push(frag(i));
  const s = p.open(1 << 20)!;
  expect(await tags(s, 3)).toEqual([0, 3, 4]);
  const pending = s.next();
  p.push(frag(5));
  expect((await pending)![0]).toBe(5);
});

test("no init yet means nothing to stream; fragments before init are ignored", () => {
  const p = new Prebuffer(4000);
  p.push(frag(1));
  expect(p.open(1 << 20)).toBeNull();
  p.setInit(new Uint8Array([0]));
  expect(p.bufferedMs).toBe(0);
});

test("a restarted source ends open streams after what was already queued", async () => {
  const p = new Prebuffer(4000);
  p.setInit(new Uint8Array([0]));
  p.push(frag(1));
  const s = p.open(1 << 20)!;
  p.setInit(new Uint8Array([9]));
  expect(await tags(s, 2)).toEqual([0, 1]);
  expect(await s.next()).toBeNull();
  expect(s.endReason).toBe("source-restarted");
});

test("a reader that falls behind is cut off instead of growing memory", async () => {
  const p = new Prebuffer(4000);
  p.setInit(new Uint8Array(10));
  const s = p.open(25)!;
  p.push({ bytes: new Uint8Array(10), durationMs: 2000 });
  p.push({ bytes: new Uint8Array(10), durationMs: 2000 });
  expect(s.endReason).toBe("overflow");
  expect(await s.next()).toBeNull();
  // The detached stream no longer receives fragments, and new streams still open.
  expect(p.open(1 << 20)).not.toBeNull();
});

test("counts fragments longer than the selected fragment length", () => {
  const p = new Prebuffer(4000);
  p.setInit(new Uint8Array([0]));
  const s = p.open(1 << 20)!;
  s.setMaxFragmentMs(4000);
  p.push(frag(1, 2000));
  p.push(frag(2, 6000));
  expect(s.oversized).toBe(1);
});
