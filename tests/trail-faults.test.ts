import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// Fault injection only: a real header-publication failure (EIO) is not reproducible on demand.
const faults = vi.hoisted(() => ({ link: undefined as undefined | (() => never), write: undefined as undefined | (() => never) }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs,
    linkSync: (...args: Parameters<typeof fs.linkSync>) => (faults.link ?? fs.linkSync)(...args),
    writeSync: ((...args: unknown[]) => (faults.write ?? (fs.writeSync as any))(...args)) as typeof fs.writeSync };
});
const { registerTrailTool } = await import("../src/trail-tool.ts");

const scratch: string[] = [];
afterEach(() => { faults.link = faults.write = undefined; for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
function trail(workspaceDir: string) {
  let factory: any;
  registerTrailTool({ registerTool: (f: any) => { factory = f; } } as any);
  return factory({ workspaceDir, fsPolicy: { workspaceOnly: false } });
}
const row = { log: "faulty", phase: "frame", decision: "d", why: "w", evidence: "e", result: "r" };
const fail = (code: string) => () => { throw Object.assign(Error(code), { code }); };

for (const [name, inject] of [["linking", () => { faults.link = fail("EIO"); }], ["writing", () => { faults.write = fail("ENOSPC"); }]] as const)
  it("removes its temporary file and creates no log when " + name + " the header fails", async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "trail-fault-")));
    scratch.push(workspace);
    inject();
    await expect(trail(workspace).execute("x", row)).rejects.toThrow(name === "linking" ? "EIO" : "ENOSPC");
    expect(readdirSync(join(workspace, ".audit"))).toEqual([]);
  });
