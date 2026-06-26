import { AGENT_TEMPLATES } from "@rtos/agent-runtime";

export const tools = [
  {
    name: "cve_monitor_status",
    description: "Get CVE monitor status — last update, statistics, and current CVE data",
    inputSchema: { type: "object", properties: { includeAll: { type: "boolean" } } },
  },
  {
    name: "cve_search",
    description: "Search CVE database by ID, keyword, severity, or exploited status",
    inputSchema: {
      type: "object",
      properties: {
        cveId: { type: "string" },
        keyword: { type: "string" },
        severity: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
        exploited: { type: "boolean" },
        limit: { type: "number", default: 50 },
      },
    },
  },
  {
    name: "cve_force_update",
    description: "Force immediate CVE database update (CEO only)",
    inputSchema: { type: "object", properties: { confirm: { type: "boolean" } }, required: ["confirm"] },
  },
  {
    name: "oauth_register_client",
    description: "Register OAuth 2.1 client for agent authentication",
    inputSchema: {
      type: "object",
      properties: {
        client_name: { type: "string" },
        redirect_uris: { type: "array", items: { type: "string" } },
        grant_types: { type: "array", items: { type: "string" } },
        scopes: { type: "array", items: { type: "string" } },
      },
      required: ["client_name", "redirect_uris"],
    },
  },
  {
    name: "oauth_authorize",
    description: "Generate authorization code with PKCE",
    inputSchema: {
      type: "object",
      properties: {
        client_id: { type: "string" },
        redirect_uri: { type: "string" },
        scope: { type: "string" },
        code_challenge: { type: "string" },
        code_challenge_method: { type: "string", enum: ["S256"] },
        state: { type: "string" },
      },
      required: ["client_id", "redirect_uri", "scope", "code_challenge", "code_challenge_method"],
    },
  },
  {
    name: "oauth_token",
    description: "Exchange authorization code for access token",
    inputSchema: {
      type: "object",
      properties: {
        grant_type: { type: "string", enum: ["authorization_code", "refresh_token"] },
        code: { type: "string" },
        client_id: { type: "string" },
        client_secret: { type: "string" },
        redirect_uri: { type: "string" },
        code_verifier: { type: "string" },
        refresh_token: { type: "string" },
      },
      required: ["grant_type", "client_id"],
    },
  },
  {
    name: "encrypt_data",
    description: "Encrypt sensitive data using AES-256-GCM",
    inputSchema: { type: "object", properties: { data: { type: "string" }, label: { type: "string" } }, required: ["data"] },
  },
  {
    name: "decrypt_data",
    description: "Decrypt AES-256-GCM encrypted data",
    inputSchema: { type: "object", properties: { ciphertext: { type: "string" }, agentId: { type: "string" } }, required: ["ciphertext"] },
  },
  {
    name: "spawn_agent",
    description: "Spawn a specialized agent",
    inputSchema: {
      type: "object",
      properties: {
        template: { type: "string", enum: Object.keys(AGENT_TEMPLATES) },
        customRole: { type: "string" },
        autoStart: { type: "boolean" },
        budget: { type: "object", properties: { tradingLimit: { type: "number" }, gasLimit: { type: "number" }, apiCostLimit: { type: "number" }, currency: { type: "string" } } },
        wallets: { type: "array", items: { type: "object", properties: { chain: { type: "string" }, address: { type: "string" }, purpose: { type: "string" }, privateKey: { type: "string" } } } },
        createdBy: { type: "string" },
      },
      required: ["template", "createdBy"],
    },
  },
  {
    name: "grant_permission",
    description: "CEO grants permissions to agent",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        permissionType: { type: "string", enum: ["file_access", "network", "system_command", "financial", "installation"] },
        scope: { type: "string" },
      },
      required: ["agentId", "permissionType", "scope"],
    },
  },
  {
    name: "revoke_permission",
    description: "CEO revokes permissions from agent",
    inputSchema: { type: "object", properties: { agentId: { type: "string" }, permissionType: { type: "string" }, scope: { type: "string" } }, required: ["agentId", "permissionType"] },
  },
  {
    name: "request_approval",
    description: "Agent requests approval for sensitive operation",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        requestType: { type: "string", enum: ["install_tool", "execute_command", "financial_transaction", "api_access"] },
        description: { type: "string" },
        riskLevel: { type: "string", enum: ["low", "medium", "high", "critical"] },
        details: { type: "object" },
      },
      required: ["agentId", "requestType", "description", "riskLevel"],
    },
  },
  {
    name: "approve_request",
    description: "CEO approves/denies agent request",
    inputSchema: { type: "object", properties: { requestId: { type: "string" }, approved: { type: "boolean" }, notes: { type: "string" } }, required: ["requestId", "approved"] },
  },
  {
    name: "list_pending_approvals",
    description: "View all pending approval requests",
    inputSchema: { type: "object", properties: { filterByRisk: { type: "string", enum: ["low", "medium", "high", "critical"] }, filterByAgent: { type: "string" } } },
  },
  {
    name: "execute_system_command",
    description: "Execute system command (requires permission)",
    inputSchema: { type: "object", properties: { agentId: { type: "string" }, command: { type: "string" }, workingDirectory: { type: "string" }, sudo: { type: "boolean", default: false } }, required: ["agentId", "command"] },
  },
  {
    name: "install_tool",
    description: "Install system tool/package",
    inputSchema: { type: "object", properties: { toolName: { type: "string" }, installCommand: { type: "string" }, requestedBy: { type: "string" }, purpose: { type: "string" } }, required: ["toolName", "installCommand", "requestedBy", "purpose"] },
  },
  {
    name: "assign_wallet",
    description: "Assign crypto wallet to agent with encrypted private key",
    inputSchema: { type: "object", properties: { agentId: { type: "string" }, chain: { type: "string" }, address: { type: "string" }, privateKey: { type: "string" }, purpose: { type: "string" }, gasAllowance: { type: "string" } }, required: ["agentId", "chain", "address", "purpose"] },
  },
  {
    name: "set_agent_budget",
    description: "Set or modify financial budget for agent",
    inputSchema: { type: "object", properties: { agentId: { type: "string" }, tradingLimit: { type: "number" }, gasLimit: { type: "number" }, apiCostLimit: { type: "number" }, currency: { type: "string" } }, required: ["agentId"] },
  },
  {
    name: "financial_transaction",
    description: "Execute financial transaction",
    inputSchema: { type: "object", properties: { agentId: { type: "string" }, transactionType: { type: "string", enum: ["trade", "transfer", "stake", "swap", "provide_liquidity"] }, details: { type: "object" }, requiresApproval: { type: "boolean", default: true } }, required: ["agentId", "transactionType", "details"] },
  },
  {
    name: "control_agent",
    description: "CEO ultimate control: STOP, START, PAUSE, TERMINATE",
    inputSchema: { type: "object", properties: { agentId: { type: "string" }, command: { type: "string", enum: ["stop", "start", "pause", "terminate", "restart"] }, reason: { type: "string" } }, required: ["agentId", "command", "reason"] },
  },
  {
    name: "assign_task",
    description: "Assign task to agent with priority",
    inputSchema: { type: "object", properties: { agentId: { type: "string" }, taskDescription: { type: "string" }, priority: { type: "string", enum: ["low", "medium", "high", "critical"] }, requirements: { type: "object" }, assignedBy: { type: "string" } }, required: ["agentId", "taskDescription", "priority", "assignedBy"] },
  },
  {
    name: "list_agents",
    description: "List all agents with optional filters",
    inputSchema: { type: "object", properties: { filterByRole: { type: "string" }, filterByStatus: { type: "string" }, includeFinancial: { type: "boolean" } } },
  },
  {
    name: "get_agent_status",
    description: "Get detailed status of a specific agent",
    inputSchema: { type: "object", properties: { agentId: { type: "string" }, includeFinancial: { type: "boolean" } }, required: ["agentId"] },
  },
  {
    name: "delegate_authority",
    description: "Grant or revoke Jr CEO authority",
    inputSchema: { type: "object", properties: { jrCeoAgentId: { type: "string" }, grant: { type: "boolean" }, limitations: { type: "array", items: { type: "string" } } }, required: ["jrCeoAgentId", "grant"] },
  },
  {
    name: "create_agent_team",
    description: "Spawn coordinated team of agents for complex operations",
    inputSchema: { type: "object", properties: { teamName: { type: "string" }, agentTemplates: { type: "array", items: { type: "string" } }, mission: { type: "string" }, sharedBudget: { type: "object" }, createdBy: { type: "string" } }, required: ["teamName", "agentTemplates", "mission", "createdBy"] },
  },
  {
    name: "agent_report",
    description: "Agent submits progress report or findings",
    inputSchema: { type: "object", properties: { agentId: { type: "string" }, reportType: { type: "string", enum: ["progress", "completion", "blocker", "finding", "financial"] }, summary: { type: "string" }, details: { type: "object" } }, required: ["agentId", "reportType", "summary"] },
  },
  {
    name: "get_system_overview",
    description: "Complete system status",
    inputSchema: { type: "object", properties: { includeLog: { type: "boolean" }, logLimit: { type: "number" }, includeEncryptedData: { type: "boolean" } } },
  },
  {
    name: "get_encryption_key",
    description: "CEO retrieves master encryption key (CRITICAL — CEO ONLY)",
    inputSchema: { type: "object", properties: { confirm: { type: "boolean" } }, required: ["confirm"] },
  },
] as const;
