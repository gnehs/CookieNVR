// Test worker: holds `mb` megabytes resident (0 = a normal idle worker), optionally spawning a child that does the same.
const [mb = "0", childMb = "0"] = process.argv.slice(2);

function hold(megabytes: number): Uint8Array[] {
  const blocks: Uint8Array[] = [];
  for (let i = 0; i < megabytes; i++) blocks.push(new Uint8Array(1024 * 1024).fill(1));
  return blocks;
}

const held = hold(Number(mb));
if (Number(childMb) > 0) Bun.spawn([process.execPath, import.meta.path, childMb], { stdio: ["ignore", "ignore", "ignore"] });
console.log(`ready ${held.length}`);
await new Promise(() => {});
