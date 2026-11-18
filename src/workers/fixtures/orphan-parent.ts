// Stands in for a main process that gets SIGKILLed while its workers run.
import { createSupervisor } from "../supervisor.ts";

const [logDir, workerCmd] = process.argv.slice(2);
if (!logDir || !workerCmd) throw new Error("usage: orphan-parent.ts <logDir> <shell command>");

createSupervisor({ logDir }).apply([{ id: "orphan", kind: "record", cmd: ["sh", "-c", workerCmd] }]);
await new Promise(() => {});
