import { join } from "node:path";

export const thumbPath = (dataDir: string, id: number) => join(dataDir, "thumbs", `${id}.jpg`);
