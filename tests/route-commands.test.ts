import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createEmptyPluginRegistry } from "host-test/empty-registry";
import { registerPluginCommandInRegistry, isReservedCommandName } from "host-test/command-registration";
import { loadSkillRootRecords } from "host-test/skill-root-loader";
import { createSkillEntry } from "host-test/skill-entry-metadata";
import { buildWorkspaceSkillCommandSpecs } from "host-test/skill-command-specs";
import { register } from "../src/index.ts";
import { register as compiledRegister } from "../dist/index.js";

const root = resolve(import.meta.dirname, "..");
function definitions(bareRouteAliases: unknown = false, registerPlugin = register) {
  const commands: any[] = [];
  registerPlugin(createTestPluginApi({
    id: "pstack", pluginConfig: { bareRouteAliases },
    runtime: { state: { openKeyedStoreV2() { throw Error("registration must not open state"); } } },
    registerCommand: (command: any) => commands.push(command),
  } as any));
  return commands;
}
describe("native route command registration and skill discovery", () => {
  it("registers all 57 literal hyphenated routes through the actual host registry", async () => {
    const routes = JSON.parse(await readFile(join(root, "skills/pstack/native/routes.json"), "utf8"));
    const expected = [...routes.workflows, ...routes.playbooks];
    const commands = definitions(false, compiledRegister);
    expect(commands.map(command => command.name)).toEqual(["pstack", "poteto_mode", ...expected.map(name => "pstack-" + name)]);
    const registry = createEmptyPluginRegistry();
    for (const command of commands) {
      expect(command.requireAuth).toBe(true);
      expect(command.requiredScopes).toEqual(["operator.write"]);
      expect(command.runtimeCapabilities).toBeUndefined();
      expect(registerPluginCommandInRegistry(registry, "pstack", command)).toEqual({ ok: true });
    }
    expect(registry.commands).toHaveLength(59);
    expect(registry.commands.find(entry => entry.command.name === "pstack-architect")).toBeDefined();
    for (const name of ["statechart", "ketchup-video"])
      expect(registry.commands.find(entry => entry.command.name === "pstack-" + name)).toBeDefined();
    expect(registry.commands.find(entry => entry.command.name === "architect")).toBeUndefined();
    // Future additions must not sneak a core name into the opt-in set.
    for (const route of expected) expect(isReservedCommandName(route)).toBe(false);
    const before = [...registry.commands];
    expect(registerPluginCommandInRegistry(registry, "pstack", { ...commands[0], name: "loop" })).toMatchObject({ ok: false, error: expect.stringContaining("reserved") });
    expect(registry.commands).toEqual(before);
  });
  it("requires exact boolean opt-in for bare aliases and leaves collisions with their owner", () => {
    for (const value of [undefined, false, "true", 1]) expect(definitions(value)).toHaveLength(59);
    const commands = definitions(true);
    expect(commands).toHaveLength(116);
    const registry = createEmptyPluginRegistry();
    const incumbent = { ...commands[0], name: "architect", description: "Existing plugin command" };
    expect(registerPluginCommandInRegistry(registry, "incumbent", incumbent)).toEqual({ ok: true });
    const results = commands.map(command => registerPluginCommandInRegistry(registry, "pstack", command));
    expect(results.filter(result => !result.ok)).toEqual([{ ok: false, error: 'Command "architect" already registered by plugin "incumbent"' }]);
    expect(registry.commands.find(entry => entry.command.name === "architect")?.pluginId).toBe("incumbent");
    expect(registry.commands.some(entry => entry.command.name === "loop")).toBe(false);
  });
  it("loads only manifest roots, hides manual routes from model prompts and observes real picker sanitization", async () => {
    const manifest = JSON.parse(await readFile(join(root, "openclaw.plugin.json"), "utf8"));
    const records = manifest.skills.flatMap((dir: string) => loadSkillRootRecords({
      dir: resolve(root, dir), source: "plugin", mode: "audit", rejectHardlinks: false,
    }));
    const entries = records.map(record => createSkillEntry(record));
    expect(entries).toHaveLength(59);
    const commands = buildWorkspaceSkillCommandSpecs(process.env.HOME!, { entries, config: { plugins: { enabled: false } } });
    expect(commands).toHaveLength(57);
    expect(new Set(commands.map(command => command.name)).size).toBe(57);
    expect(commands.every(command => command.modelVisible === false && command.name.startsWith("pstack_"))).toBe(true);
    const architect = commands.find(command => command.skillName === "pstack-architect");
    expect(architect?.name).toBe("pstack_architect");
    expect(commands.some(command => command.name === "pstack-architect")).toBe(false);
    for (const entry of entries) {
      expect(entry.skill.filePath).not.toContain("/upstream/");
      if (entry.skill.name.startsWith("pstack-")) expect(entry.exposure).toMatchObject({ includeInAvailableSkillsPrompt: false, userInvocable: true });
      else expect(entry.exposure).toMatchObject({ includeInAvailableSkillsPrompt: true, userInvocable: false });
    }
  });
});
