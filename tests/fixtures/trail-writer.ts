// Cross-process trail writer: one real OS process per concurrent appender.
// "shared" appends count rows to one log; "fresh" appends one row to each of
// count new logs, so every log has its own concurrent creation window.
import { existsSync } from "node:fs";
import { registerTrailTool } from "../../src/trail-tool.ts";

const [workspace, go, id, count, mode] = process.argv.slice(2);
let factory: any;
registerTrailTool({ registerTool: (f: any) => { factory = f; } } as any);
const trail = factory({ workspaceDir: workspace, fsPolicy: { workspaceOnly: false } });
const deadline = Date.now() + 30_000;
while (!existsSync(go!)) if (Date.now() > deadline) throw Error("barrier timeout");
for (let i = 0; i < Number(count); i++)
  await trail.execute("p" + id + "-" + i, { log: mode === "fresh" ? "fresh-" + i : "shared", phase: "worker",
    decision: "process " + id + " row " + i, why: "cross-process append", evidence: "pid " + process.pid, result: "appended" });
