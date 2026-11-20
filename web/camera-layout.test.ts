import { describe, expect, test } from "bun:test";
import type { CameraDto, CameraGroupDto } from "../src/api-types.ts";
import type { CameraId, GroupId } from "../src/types.ts";
import { applyLayout, arrangementOf, layoutOf, moveCamera, sectionsOf, UNGROUPED } from "./camera-layout.ts";

const cam = (id: string, position: number, groupId: string | null = null) => ({ id, position, groupId }) as unknown as CameraDto;
const group = (id: string, name = id) => ({ id: id as GroupId, name }) satisfies CameraGroupDto;
const ids = (list: { id: string }[]) => list.map((x) => x.id);

describe("camera layout", () => {
  const cams = [cam("d", 3, "out"), cam("a", 0), cam("c", 2, "in"), cam("b", 1, "gone")];
  const groups = [group("in"), group("out")];

  test("sections put cameras without a group first, then each group in order", () => {
    const s = sectionsOf(cams, groups);
    expect(s.map((x): unknown[] => [x.group?.id ?? null, ids(x.cameras)])).toEqual([
      [null, ["a", "b"]],
      ["in", ["c"]],
      ["out", ["d"]],
    ]);
  });

  test("no ungrouped section when every camera has a group; empty groups still listed", () => {
    const s = sectionsOf([cam("c", 0, "in")], groups);
    expect(s.map((x): unknown[] => [x.group?.id, ids(x.cameras)])).toEqual([
      ["in", ["c"]],
      ["out", []],
    ]);
  });

  test("moving a camera across boxes produces the arrangement the server expects", () => {
    const moved = moveCamera(layoutOf(cams, groups), "a" as CameraId, "out" as GroupId, 0);
    expect(arrangementOf({ ...moved, groups: ["out", "in"] as GroupId[] })).toEqual({
      groups: ["out", "in"],
      cameras: [
        { id: "b", groupId: null },
        { id: "a", groupId: "out" },
        { id: "d", groupId: "out" },
        { id: "c", groupId: "in" },
      ],
    } as never);
  });

  test("moving within the same box reorders it", () => {
    const moved = moveCamera(layoutOf(cams, groups), "a" as CameraId, UNGROUPED, 5);
    expect(moved.boxes[UNGROUPED]).toEqual(["b", "a"] as CameraId[]);
  });

  test("applyLayout rewrites positions and group order for the cache", () => {
    const layout = moveCamera(layoutOf(cams, groups), "d" as CameraId, UNGROUPED, 0);
    const out = applyLayout(cams, groups, { ...layout, groups: ["out", "in"] as GroupId[] });
    expect(out.cams.map((c): unknown[] => [c.id, c.position, c.groupId])).toEqual([
      ["d", 0, null],
      ["a", 1, null],
      ["b", 2, null],
      ["c", 3, "in"],
    ]);
    expect(ids(out.groups)).toEqual(["out", "in"]);
  });
});
