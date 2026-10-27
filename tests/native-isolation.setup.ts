import { realpathSync } from "node:fs";
import { dirname, relative, isAbsolute } from "node:path";
import { resolveManagedUpdateLeaseDatabasePath } from "host-test/handoff-path";

// Runs before test modules. TMPDIR alone is not evidence: ask the actual host
// resolver and canonicalize the selected directory, without opening a database.
const root = realpathSync(process.env.TMPDIR!);
const permitted = new Set(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
for (const name of Object.keys(process.env))
  if (name.startsWith("OPENCLAW_") && !permitted.has(name))
    throw Error("Inherited host variable reached a test worker: " + name);
for (const name of ["HOME", "OPENCLAW_STATE_DIR"]) {
  const value = realpathSync(process.env[name]!);
  const child = relative(root, value);
  if (!child || child.startsWith("..") || isAbsolute(child))
    throw Error(name + " escaped task-private scratch: " + value);
}
if (realpathSync(dirname(process.env.OPENCLAW_CONFIG_PATH!)) !== root)
  throw Error("Config escaped task-private scratch");
const database = resolveManagedUpdateLeaseDatabasePath();
const directory = realpathSync(dirname(database));
const within = relative(root, directory);
if (!within || within.startsWith("..") || isAbsolute(within))
  throw Error("Handoff database escaped task-private scratch: " + database);
console.info(JSON.stringify({ privateHandoffDatabase: database, canonicalDirectory: directory }));
