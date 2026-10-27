import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { isolateHostEnvironment } from "./host-fixture.mjs";

// Pure reducers/guard only: no host modules, stores or model calls. Strip
// inherited Gateway variables and establish private HOME/state/TMPDIR first.
const { cleanup } = isolateHostEnvironment("pstack-workflow-");
try {
  const result = spawnSync(process.execPath, ["--test", "tests/workflow.test.mjs"], {
    cwd: resolve(import.meta.dirname, ".."), stdio: "inherit", env: process.env,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { cleanup(); }
