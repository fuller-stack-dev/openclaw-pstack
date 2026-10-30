import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { qualifiedHost, isolateHostEnvironment } from "./host-fixture.mjs";
const host = qualifiedHost();
const root = resolve(import.meta.dirname, "..");
const { scratch: dir, cleanup } = isolateHostEnvironment("pstack-types-");
try {
  // Emit declarations from the exact pinned SDK into disposable scratch. Only
  // host emission is unchecked; plugin checking below remains strict, with no
  // patched contracts, augmentations or fallback to a newer host.
  const base = JSON.parse(await readFile(join(host, "tsconfig.json"), "utf8"));
  const paths = Object.fromEntries(
    Object.entries(base.compilerOptions.paths).map(([k, v]) => [k, v.map((p) => resolve(host, p))]),
  );
  const sdk = {
    compilerOptions: {
      ...base.compilerOptions,
      paths,
      typeRoots: [join(host, "node_modules/@types")],
      noEmit: false,
      noEmitOnError: false,
      noCheck: true,
      emitDeclarationOnly: true,
      declaration: true,
      rootDir: host,
      outDir: join(dir, "sdk"),
    },
    files: [
      join(host, "src/plugin-sdk/plugin-entry.ts"),
      join(host, "src/plugin-sdk/routing.ts"),
      join(host, "src/plugin-sdk/json-schema-runtime.ts"),
    ],
  };
  await writeFile(join(dir, "sdk.json"), JSON.stringify(sdk));
  let r = spawnSync(join(host, "node_modules/.bin/tsc"), ["-p", join(dir, "sdk.json")], {
    cwd: host,
    stdio: "inherit",
  });
  if (r.status !== 0) throw Error("Pinned SDK declaration extraction failed");
  const config = {
    extends: join(root, "tsconfig.json"),
    compilerOptions: {
      typeRoots: [join(host, "node_modules/@types")],
      types: ["node"],
      paths: { "openclaw/plugin-sdk/*": [join(dir, "sdk/src/plugin-sdk/*")] },
    },
  };
  const file = join(dir, "tsconfig.json");
  await writeFile(file, JSON.stringify(config));
  r = spawnSync(join(host, "node_modules/.bin/tsc"), ["-p", file], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) throw Error("Plugin typecheck failed");
  // The reviewed port retains its own strict compiler contract, without weakening the gateway's indexed-access checks.
  const artifactFile = join(dir, "artifact.json");
  await writeFile(artifactFile, JSON.stringify({ extends: join(root, "src/artifacts/statechart/tsconfig.json"), compilerOptions: { typeRoots: [join(host, "node_modules/@types")] } }));
  r = spawnSync(join(host, "node_modules/.bin/tsc"), ["-p", artifactFile], { cwd: root, stdio: "inherit" });
  process.exitCode = r.status ?? 1;
} finally {
  cleanup();
}
