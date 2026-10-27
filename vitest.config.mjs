import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { qualifiedHost, isolateHostEnvironment } from "./scripts/host-fixture.mjs";
const host = qualifiedHost();
// Config runs before test modules, including the real handoff resolver.
isolateHostEnvironment("pstack-vitest-");
process.env.PSTACK_TEST_HOST_SOURCE = host;
// Real SQLite Node workers use the host's tsx loader, outside Vitest's resolver.
// Anchor its source paths to the pinned host rather than this plugin's cwd.
process.env.TSX_TSCONFIG_PATH = join(host, "tsconfig.json");
// Consume the pinned host's source aliases, not missing/unbuilt workspace dist.
const { createVitestResolveConfig } = await import(
  pathToFileURL(join(host, "test/vitest/vitest.resolve.ts")).href
);
export default {
  resolve: {
    alias: [
      ...createVitestResolveConfig(host).alias,
      {
        find: "host-test/caller-context",
        replacement: join(host, "src/gateway/server-methods/gateway-client-identity.ts"),
      },
      // Version-tolerant: the host's exported tool preparation, not a private helper.
      {
        find: "host-test/tool-schema",
        replacement: join(import.meta.dirname, "tests/fixtures/host-tool-schema.ts"),
      },
      {
        find: "host-test/agent-tools-finalize",
        replacement: join(host, "src/agents/agent-tools.finalize.ts"),
      },
      {
        find: "host-test/handoff-path",
        replacement: join(host, "src/infra/update-managed-service-handoff-lease.ts"),
      },
      { find: "host-test/agent-core", replacement: join(host, "packages/agent-core/src/index.ts") },
      { find: "host-test/llm-core", replacement: join(host, "packages/llm-core/src/index.ts") },
      { find: "host-test/sessions-spawn", replacement: join(host, "src/agents/tools/sessions-spawn-tool.ts") },
      { find: "host-test/acp-registry", replacement: join(host, "src/acp/runtime/registry.ts") },
      { find: "host-test/agents-wait", replacement: join(host, "src/agents/tools/agents-wait-tool.ts") },
      { find: "host-test/sessions-yield", replacement: join(host, "src/agents/tools/sessions-yield-tool.ts") },
      { find: "host-test/hook-runner-global", replacement: join(host, "src/plugins/hook-runner-global.ts") },
      { find: "host-test/before-tool-call", replacement: join(host, "src/agents/agent-tools.before-tool-call.ts") },
      { find: "host-test/tool-availability", replacement: join(host, "src/agents/agent-tool-availability.ts") },
      { find: "host-test/swarm-collector", replacement: join(host, "src/agents/subagents/swarm/swarm-collector-capability.ts") },
      { find: "host-test/captured-registration", replacement: join(host, "src/plugins/captured-registration.ts") },
      { find: "host-test/empty-registry", replacement: join(host, "src/plugins/registry-empty.ts") },
      { find: "host-test/command-registration", replacement: join(host, "src/plugins/command-registration.ts") },
      { find: "host-test/skill-root-loader", replacement: join(host, "src/skills/loading/skill-root-loader.ts") },
      { find: "host-test/skill-entry-metadata", replacement: join(host, "src/skills/loading/skill-entry-metadata.ts") },
      { find: "host-test/skill-command-specs", replacement: join(host, "src/skills/discovery/command-specs.ts") },
      { find: "host-test/min-host-version", replacement: join(host, "src/plugins/min-host-version.ts") },
      { find: "host-test/package-compat", replacement: join(host, "src/plugins/package-compat.ts") },
      { find: "host-test/plugin-manifest", replacement: join(host, "src/plugins/manifest.ts") },
      { find: "vitest", replacement: join(host, "node_modules/vitest/dist/index.js") },
    ],
  },
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/native-isolation.setup.ts"],
    testTimeout: 60000,
    hookTimeout: 120000,
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
  },
};
