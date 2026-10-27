import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { qualifiedHost, isolateHostEnvironment } from "./host-fixture.mjs";

const host = qualifiedHost();
const { cleanup } = isolateHostEnvironment("pstack-host-run-");
try {
  const result = spawnSync(process.execPath,
    [join(host, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.mjs", ...process.argv.slice(2)],
    { cwd: resolve(import.meta.dirname, ".."), stdio: "inherit",
      env: { ...process.env, OPENCLAW_SOURCE: host, TSX_TSCONFIG_PATH: join(host, "tsconfig.json") } });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  cleanup();
}
