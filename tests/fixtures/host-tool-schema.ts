import { finalizeAgentTools } from "host-test/agent-tools-finalize";

/**
 * Prepare one tool exactly as the host prepares a model-facing run: through its exported
 * finalizeAgentTools (schema normalization, argument binding and availability metadata),
 * without wrapping before_tool_call hooks. Both the tagged pin and current main export it,
 * while the narrower normalization helper is private on main.
 */
export function normalizeToolParameters(tool: any, options: { modelProvider?: string }) {
  const [prepared] = finalizeAgentTools({ tools: [tool], modelProvider: options.modelProvider, hookContext: {}, wrapBeforeToolCallHook: false });
  return prepared!;
}
