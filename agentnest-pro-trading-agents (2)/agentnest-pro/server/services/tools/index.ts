/**
 * Tool interface and registry.
 * Every tool implements ToolDefinition. The registry is the authoritative
 * source of which tools exist and what their JSON Schema looks like —
 * this schema is injected directly into the LLM prompt so the model
 * knows exactly what it can call and with what arguments.
 */

export interface ToolResult {
  success:  boolean;
  output:   string;
  error?:   string;
}

export interface ToolDefinition {
  name:        string;
  description: string;
  parameters:  Record<string, { type: string; description: string; required?: boolean }>;
  execute(args: Record<string, any>, taskId: string, agentId: string | null): Promise<ToolResult>;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const registry = new Map<string, ToolDefinition>();

export function registerTool(tool: ToolDefinition): void {
  registry.set(tool.name, tool);
}

export function getTool(name: string): ToolDefinition | undefined {
  return registry.get(name);
}

export function getToolsForAgent(allowedTools: string[]): ToolDefinition[] {
  return allowedTools
    .map(name => registry.get(name))
    .filter((t): t is ToolDefinition => t !== undefined);
}

/**
 * Serialise the tool list into a prompt-ready block.
 * Format matches the ReAct paper's action-space description.
 */
export function serializeToolsForPrompt(tools: ToolDefinition[]): string {
  if (tools.length === 0) return "No tools available. Reason from knowledge only.";
  return tools
    .map(t => {
      const params = Object.entries(t.parameters)
        .map(([k, v]) => `  - ${k} (${v.type}${v.required ? ", required" : ""}): ${v.description}`)
        .join("\n");
      return `Tool: ${t.name}\nDescription: ${t.description}\nParameters:\n${params}`;
    })
    .join("\n\n");
}

/** Serialise the tool list as a JSON Schema array for providers that support tool-calling natively. */
export function serializeToolsAsSchema(tools: ToolDefinition[]): object[] {
  return tools.map(t => ({
    name:        t.name,
    description: t.description,
    input_schema: {
      type:       "object",
      properties: Object.fromEntries(
        Object.entries(t.parameters).map(([k, v]) => [k, { type: v.type, description: v.description }])
      ),
      required: Object.entries(t.parameters)
        .filter(([, v]) => v.required)
        .map(([k]) => k),
    },
  }));
}
