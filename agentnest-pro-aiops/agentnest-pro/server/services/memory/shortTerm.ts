/**
 * Short-Term Memory — in-context window state for the current ReAct iteration.
 * Holds the running thought/action/observation chain for one task execution.
 * Scoped per task ID. Cleared when the task completes or fails.
 */

export interface ReActStep {
  step:        number;
  thought:     string;
  action:      string | null;
  actionInput: Record<string, any> | null;
  observation: string | null;
  timestamp:   string;
}

const store = new Map<string, ReActStep[]>();

export function stmInit(taskId: string): void {
  store.set(taskId, []);
}

export function stmAppend(taskId: string, step: Omit<ReActStep, "step" | "timestamp">): ReActStep {
  const history = store.get(taskId) ?? [];
  const entry: ReActStep = {
    ...step,
    step:      history.length + 1,
    timestamp: new Date().toISOString(),
  };
  history.push(entry);
  store.set(taskId, history);
  return entry;
}

export function stmGet(taskId: string): ReActStep[] {
  return store.get(taskId) ?? [];
}

/** Format the full chain as a prompt-ready string for injection into LLM context. */
export function stmSerialize(taskId: string): string {
  const steps = stmGet(taskId);
  if (steps.length === 0) return "";
  return steps
    .map(s => {
      let block = `Step ${s.step}\nThought: ${s.thought}`;
      if (s.action)      block += `\nAction: ${s.action}`;
      if (s.actionInput) block += `\nAction Input: ${JSON.stringify(s.actionInput)}`;
      if (s.observation) block += `\nObservation: ${s.observation}`;
      return block;
    })
    .join("\n\n");
}

export function stmClear(taskId: string): void {
  store.delete(taskId);
}
