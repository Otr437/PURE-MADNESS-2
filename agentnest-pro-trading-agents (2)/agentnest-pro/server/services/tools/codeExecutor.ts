/**
 * codeExecutor tool — runs JavaScript/TypeScript snippets in a sandboxed
 * Node.js vm context. The sandbox has no access to the filesystem, network,
 * or process. Output is captured from console.log calls and the return value.
 *
 * Used by: DevOps Engineer, Data Scientist, Security Expert agents.
 */

import vm from "vm";
import { registerTool, type ToolResult } from "./index.js";

const MAX_EXECUTION_MS = 5000;
const MAX_OUTPUT_CHARS = 4000;

registerTool({
  name:        "codeExecutor",
  description: "Execute JavaScript code and return the output. Use for calculations, data processing, parsing, or any algorithmic task. The sandbox has no network or filesystem access.",
  parameters: {
    code:     { type: "string", description: "JavaScript code to execute", required: true },
    language: { type: "string", description: "Language hint (currently only 'javascript' is supported)" },
  },

  async execute(args, _taskId, _agentId): Promise<ToolResult> {
    const code = String(args.code ?? "").trim();
    if (!code) return { success: false, output: "", error: "code is required" };

    const logLines: string[] = [];

    const sandbox = {
      console: {
        log:   (...a: any[]) => logLines.push(a.map(String).join(" ")),
        error: (...a: any[]) => logLines.push("[error] " + a.map(String).join(" ")),
        warn:  (...a: any[]) => logLines.push("[warn] "  + a.map(String).join(" ")),
        info:  (...a: any[]) => logLines.push("[info] "  + a.map(String).join(" ")),
      },
      JSON,
      Math,
      Date,
      Array,
      Object,
      String,
      Number,
      Boolean,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      encodeURIComponent,
      decodeURIComponent,
    };

    vm.createContext(sandbox);

    try {
      const result = await Promise.race([
        new Promise<any>((resolve, reject) => {
          try {
            const val = vm.runInContext(code, sandbox, {
              timeout:        MAX_EXECUTION_MS,
              displayErrors:  true,
              breakOnSigint:  true,
            });
            resolve(val);
          } catch (e) {
            reject(e);
          }
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Execution timed out after ${MAX_EXECUTION_MS}ms`)), MAX_EXECUTION_MS + 100)
        ),
      ]);

      const output = [
        ...logLines,
        result !== undefined && result !== null ? `Return value: ${JSON.stringify(result)}` : "",
      ]
        .filter(Boolean)
        .join("\n")
        .substring(0, MAX_OUTPUT_CHARS);

      return { success: true, output: output || "(no output)" };

    } catch (err: any) {
      return {
        success: false,
        output:  logLines.join("\n"),
        error:   err.message,
      };
    }
  },
});
