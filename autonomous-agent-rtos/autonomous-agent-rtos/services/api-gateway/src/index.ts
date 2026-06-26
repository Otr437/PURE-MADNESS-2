#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { exec } from "child_process";
import { promisify } from "util";

import { EncryptionService } from "@rtos/shared-crypto";
import { Logger } from "@rtos/shared-logger";
import { CVEMonitor } from "@rtos/cve-monitor";
import { OAuthService } from "@rtos/oauth";
import { AgentRegistry } from "@rtos/agent-runtime";
import type { AgentTemplateKey, PermissionType, TransactionType, RiskLevel } from "@rtos/shared-types";

import { tools } from "./tools.js";

const execAsync = promisify(exec);

// ── Bootstrap ──────────────────────────────────────────────────────────────
const encryption = new EncryptionService(process.env.AGENT_MASTER_KEY);
const logger = new Logger(encryption);
const cveMonitor = new CVEMonitor(logger, process.env.NVD_API_KEY);
const oauth = new OAuthService(encryption);
const agents = new AgentRegistry(encryption, logger);

cveMonitor.start();

// ── MCP Server ─────────────────────────────────────────────────────────────
const server = new Server(
  { name: "autonomous-agent-rtos", version: "4.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  const ok = (data: unknown) => ({
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  });

  const err = (msg: string) => ({
    content: [{ type: "text", text: `ERROR: ${msg}` }],
    isError: true,
  });

  try {
    switch (name) {
      // ── CVE ────────────────────────────────────────────────────────────
      case "cve_monitor_status": {
        const state = cveMonitor.getState();
        return ok({
          isRunning: state.isRunning,
          lastUpdate: state.lastUpdate,
          totalCVEs: state.totalCVEs,
          statistics: state.statistics,
          criticalCVEs: (args as { includeAll?: boolean }).includeAll
            ? state.criticalCVEs
            : state.criticalCVEs.slice(0, 10),
          cisaKEVCount: state.cisaKEV.length,
        });
      }

      case "cve_search": {
        const a = args as { cveId?: string; keyword?: string; severity?: "CRITICAL"|"HIGH"|"MEDIUM"|"LOW"; exploited?: boolean; limit?: number };
        const results = cveMonitor.search({ cveId: a.cveId, keyword: a.keyword, severity: a.severity, exploited: a.exploited, limit: a.limit });
        return ok({ count: results.length, results });
      }

      case "cve_force_update": {
        if (!(args as { confirm?: boolean }).confirm) return err("confirm must be true");
        await cveMonitor.update();
        return ok({ message: "CVE database updated", state: cveMonitor.getState().statistics });
      }

      // ── OAuth ──────────────────────────────────────────────────────────
      case "oauth_register_client": {
        const a = args as { client_name: string; redirect_uris: string[]; grant_types?: string[]; scopes?: string[] };
        const client = oauth.registerClient(a);
        return ok(client);
      }

      case "oauth_authorize": {
        const a = args as { client_id: string; redirect_uri: string; scope: string; code_challenge: string; code_challenge_method: "S256"; state?: string };
        const code = oauth.generateAuthCode(a);
        return ok({ authorization_code: code, state: a.state });
      }

      case "oauth_token": {
        const a = args as { grant_type: string; code?: string; client_id: string; client_secret?: string; redirect_uri?: string; code_verifier?: string; refresh_token?: string };
        if (a.grant_type === "authorization_code") {
          if (!a.code || !a.redirect_uri || !a.code_verifier) return err("code, redirect_uri, code_verifier required");
          const token = oauth.exchangeCode({ code: a.code, client_id: a.client_id, client_secret: a.client_secret, redirect_uri: a.redirect_uri, code_verifier: a.code_verifier });
          return ok(token);
        }
        if (a.grant_type === "refresh_token") {
          if (!a.refresh_token) return err("refresh_token required");
          const token = oauth.refreshToken(a.refresh_token);
          return ok(token);
        }
        return err(`Unsupported grant_type: ${a.grant_type}`);
      }

      // ── Crypto ─────────────────────────────────────────────────────────
      case "encrypt_data": {
        const a = args as { data: string; label?: string };
        return ok({ ciphertext: encryption.encrypt(a.data), label: a.label });
      }

      case "decrypt_data": {
        const a = args as { ciphertext: string };
        return ok({ plaintext: encryption.decrypt(a.ciphertext) });
      }

      // ── Agents ─────────────────────────────────────────────────────────
      case "spawn_agent": {
        const a = args as { template: AgentTemplateKey; customRole?: string; autoStart?: boolean; budget?: object; wallets?: { chain: string; address: string; purpose: string; privateKey?: string }[]; createdBy: string };
        const agent = agents.spawnAgent({ template: a.template, customRole: a.customRole, autoStart: a.autoStart, budget: a.budget as never, wallets: a.wallets, createdBy: a.createdBy });
        return ok(agent);
      }

      case "grant_permission": {
        const a = args as { agentId: string; permissionType: PermissionType; scope: string };
        const perm = agents.grantPermission({ agentId: a.agentId, permissionType: a.permissionType, scope: a.scope });
        return ok(perm);
      }

      case "revoke_permission": {
        const a = args as { agentId: string; permissionType: PermissionType; scope?: string };
        agents.revokePermission(a.agentId, a.permissionType, a.scope);
        return ok({ revoked: true });
      }

      case "request_approval": {
        const a = args as { agentId: string; requestType: "install_tool"|"execute_command"|"financial_transaction"|"api_access"; description: string; riskLevel: RiskLevel; details?: Record<string, unknown> };
        const req = agents.requestApproval(a);
        return ok(req);
      }

      case "approve_request": {
        const a = args as { requestId: string; approved: boolean; notes?: string };
        const req = agents.approveRequest(a.requestId, a.approved, a.notes);
        return ok(req);
      }

      case "list_pending_approvals": {
        const a = args as { filterByRisk?: RiskLevel; filterByAgent?: string };
        return ok(agents.listPendingApprovals({ riskLevel: a.filterByRisk, agentId: a.filterByAgent }));
      }

      case "execute_system_command": {
        const a = args as { agentId: string; command: string; workingDirectory?: string; sudo?: boolean };
        if (!agents.checkPermission(a.agentId, "system_command", "*")) {
          return err("Agent lacks system_command permission");
        }
        const cmd = a.sudo ? `sudo ${a.command}` : a.command;
        const { stdout, stderr } = await execAsync(cmd, { cwd: a.workingDirectory });
        logger.record(a.agentId, "execute-command", a.command, undefined, "warn", true);
        return ok({ stdout, stderr });
      }

      case "install_tool": {
        const a = args as { toolName: string; installCommand: string; requestedBy: string; purpose: string };
        if (!agents.checkPermission(a.requestedBy, "installation", "*")) {
          const req = agents.requestApproval({ agentId: a.requestedBy, requestType: "install_tool", description: `Install ${a.toolName}: ${a.purpose}`, riskLevel: "medium", details: { installCommand: a.installCommand } });
          return ok({ status: "pending_approval", approvalRequestId: req.id });
        }
        const { stdout, stderr } = await execAsync(a.installCommand);
        return ok({ installed: a.toolName, stdout, stderr });
      }

      case "assign_wallet": {
        const a = args as { agentId: string; chain: string; address: string; privateKey?: string; purpose: string; gasAllowance?: string };
        const wallet = agents.assignWallet(a.agentId, a);
        return ok(wallet);
      }

      case "set_agent_budget": {
        const a = args as { agentId: string; tradingLimit?: number; gasLimit?: number; apiCostLimit?: number; currency?: string };
        const { agentId, ...budget } = a;
        return ok(agents.setBudget(agentId, budget));
      }

      case "financial_transaction": {
        const a = args as { agentId: string; transactionType: TransactionType; details: Record<string, unknown>; requiresApproval?: boolean };
        return ok(agents.executeFinancialTransaction({ agentId: a.agentId, transactionType: a.transactionType, details: a.details, requiresApproval: a.requiresApproval }));
      }

      case "control_agent": {
        const a = args as { agentId: string; command: "stop"|"start"|"pause"|"terminate"|"restart"; reason: string };
        return ok(agents.controlAgent(a.agentId, a.command, a.reason));
      }

      case "assign_task": {
        const a = args as { agentId: string; taskDescription: string; priority: "low"|"medium"|"high"|"critical"; requirements?: Record<string, unknown>; assignedBy: string };
        return ok(agents.assignTask(a.agentId, a.taskDescription, a.priority, a.assignedBy, a.requirements));
      }

      case "list_agents": {
        const a = args as { filterByRole?: string; filterByStatus?: string; includeFinancial?: boolean };
        const list = agents.listAgents({ role: a.filterByRole, status: a.filterByStatus });
        return ok(a.includeFinancial ? list : list.map(({ wallets: _, budget: __, ...rest }) => rest));
      }

      case "get_agent_status": {
        const a = args as { agentId: string; includeFinancial?: boolean };
        const agent = agents.getAgent(a.agentId);
        return ok(a.includeFinancial ? agent : (({ wallets: _, budget: __, ...rest }) => rest)(agent));
      }

      case "delegate_authority": {
        const a = args as { jrCeoAgentId: string; grant: boolean; limitations?: string[] };
        agents.delegateAuthority(a.jrCeoAgentId, a.grant, a.limitations);
        return ok({ delegated: a.grant, agentId: a.jrCeoAgentId });
      }

      case "create_agent_team": {
        const a = args as { teamName: string; agentTemplates: AgentTemplateKey[]; mission: string; sharedBudget?: object; createdBy: string };
        const team = agents.createTeam(a.teamName, a.agentTemplates, a.mission, a.sharedBudget as never, a.createdBy);
        return ok({ teamName: a.teamName, agents: team.map((ag) => ({ id: ag.id, role: ag.role })) });
      }

      case "agent_report": {
        const a = args as { agentId: string; reportType: "progress"|"completion"|"blocker"|"finding"|"financial"; summary: string; details?: Record<string, unknown> };
        return ok(agents.submitReport(a.agentId, a.reportType, a.summary, a.details));
      }

      case "get_system_overview": {
        const a = args as { includeLog?: boolean; logLimit?: number };
        const state = cveMonitor.getState();
        return ok({
          ceo: "HUMAN_ADMIN",
          jrCeoId: agents.getJrCeoId(),
          totalAgents: agents.listAgents().length,
          agents: agents.listAgents().map((ag) => ({ id: ag.id, role: ag.role, status: ag.status })),
          cveMonitor: { isRunning: state.isRunning, lastUpdate: state.lastUpdate, statistics: state.statistics },
          pendingApprovals: agents.listPendingApprovals().length,
          log: a.includeLog ? logger.getEntries(a.logLimit) : undefined,
        });
      }

      case "get_encryption_key": {
        if (!(args as { confirm?: boolean }).confirm) return err("confirm must be true");
        logger.record("CEO", "get-encryption-key", "Master key retrieved", undefined, "critical");
        return ok({ masterKey: encryption.getMasterKey() });
      }

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return err((e as Error).message);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
