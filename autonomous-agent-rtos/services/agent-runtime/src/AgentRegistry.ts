import type { EncryptionService } from "@rtos/shared-crypto";
import type { Logger } from "@rtos/shared-logger";
import type {
  Agent,
  AgentTask,
  AgentReport,
  AgentPermission,
  AgentWallet,
  AgentBudget,
  ApprovalRequest,
  AgentTemplateKey,
  PermissionType,
  RiskLevel,
  TransactionType,
} from "@rtos/shared-types";
import { AGENT_TEMPLATES } from "./agentTemplates.js";

function generateId(prefix = "agent"): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

export interface SpawnAgentInput {
  template: AgentTemplateKey;
  customRole?: string;
  autoStart?: boolean;
  budget?: AgentBudget;
  wallets?: Omit<AgentWallet, "encryptedPrivateKey">[];
  createdBy: string;
}

export interface GrantPermissionInput {
  agentId: string;
  permissionType: PermissionType;
  scope: string;
}

export interface RequestApprovalInput {
  agentId: string;
  requestType: ApprovalRequest["requestType"];
  description: string;
  riskLevel: RiskLevel;
  details?: Record<string, unknown>;
}

export interface FinancialTransactionInput {
  agentId: string;
  transactionType: TransactionType;
  details: Record<string, unknown>;
  requiresApproval?: boolean;
}

export class AgentRegistry {
  private readonly agents = new Map<string, Agent>();
  private readonly approvalQueue: ApprovalRequest[] = [];
  private jrCeoId: string | null = null;

  constructor(
    private readonly encryption: EncryptionService,
    private readonly logger: Logger
  ) {}

  spawnAgent(input: SpawnAgentInput): Agent {
    const template = AGENT_TEMPLATES[input.template];
    if (!template) throw new Error(`Unknown template: ${input.template}`);

    const id = generateId("agent");
    const encryptedWallets: AgentWallet[] = (input.wallets ?? []).map((w) => {
      const wallet: AgentWallet = { ...w };
      return wallet;
    });

    const agent: Agent = {
      id,
      template: input.template,
      role: input.customRole ?? template.role,
      capabilities: [...template.capabilities],
      skills: [...template.skills],
      permissions: template.permissions.map((p) => ({ ...p })),
      status: input.autoStart ? "running" : "idle",
      createdBy: input.createdBy,
      createdAt: new Date().toISOString(),
      budget: input.budget,
      wallets: encryptedWallets,
      tasks: [],
      reports: [],
      isBackgroundAgent: template.isBackgroundAgent ?? false,
    };

    this.agents.set(id, agent);
    this.logger.record(
      input.createdBy,
      "spawn-agent",
      `Spawned ${agent.role}`,
      id
    );

    return agent;
  }

  getAgent(agentId: string): Agent {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    return agent;
  }

  listAgents(filters?: {
    role?: string;
    status?: string;
  }): Agent[] {
    let list = Array.from(this.agents.values());
    if (filters?.role) {
      list = list.filter((a) =>
        a.role.toLowerCase().includes(filters.role!.toLowerCase())
      );
    }
    if (filters?.status) {
      list = list.filter((a) => a.status === filters.status);
    }
    return list;
  }

  controlAgent(
    agentId: string,
    command: "stop" | "start" | "pause" | "terminate" | "restart",
    reason: string
  ): Agent {
    const agent = this.getAgent(agentId);

    switch (command) {
      case "stop":
      case "pause":
        agent.status = "paused";
        break;
      case "start":
      case "restart":
        agent.status = "running";
        break;
      case "terminate":
        agent.status = "terminated";
        break;
    }

    this.logger.record(
      "CEO",
      `agent-${command}`,
      reason,
      agentId,
      command === "terminate" ? "warn" : "info"
    );

    return agent;
  }

  grantPermission(input: GrantPermissionInput): AgentPermission {
    const agent = this.getAgent(input.agentId);
    const existing = agent.permissions.find(
      (p) => p.type === input.permissionType && p.scope === input.scope
    );

    if (existing) {
      existing.granted = true;
      return existing;
    }

    const perm: AgentPermission = {
      type: input.permissionType,
      scope: input.scope,
      granted: true,
    };

    agent.permissions.push(perm);
    this.logger.record(
      "CEO",
      "grant-permission",
      `${input.permissionType}:${input.scope}`,
      input.agentId
    );
    return perm;
  }

  revokePermission(agentId: string, permissionType: PermissionType, scope?: string): void {
    const agent = this.getAgent(agentId);
    agent.permissions = agent.permissions.filter(
      (p) =>
        !(
          p.type === permissionType &&
          (!scope || p.scope === scope)
        )
    );
    this.logger.record("CEO", "revoke-permission", permissionType, agentId, "warn");
  }

  checkPermission(agentId: string, permType: PermissionType, scope?: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    return agent.permissions.some(
      (p) =>
        p.type === permType &&
        p.granted &&
        (!scope || p.scope === scope || p.scope === "*")
    );
  }

  requestApproval(input: RequestApprovalInput): ApprovalRequest {
    const request: ApprovalRequest = {
      id: generateId("req"),
      ...input,
      status: "pending",
      requestedAt: new Date().toISOString(),
    };
    this.approvalQueue.push(request);
    this.logger.record(
      input.agentId,
      "request-approval",
      input.description,
      undefined,
      input.riskLevel === "critical" ? "warn" : "info"
    );
    return request;
  }

  approveRequest(
    requestId: string,
    approved: boolean,
    notes?: string
  ): ApprovalRequest {
    const req = this.approvalQueue.find((r) => r.id === requestId);
    if (!req) throw new Error(`Approval request not found: ${requestId}`);

    req.status = approved ? "approved" : "denied";
    req.resolvedAt = new Date().toISOString();
    req.resolvedBy = "CEO";
    req.notes = notes;

    this.logger.record(
      "CEO",
      approved ? "approve-request" : "deny-request",
      notes ?? "",
      requestId,
      approved ? "info" : "warn"
    );
    return req;
  }

  listPendingApprovals(filters?: {
    riskLevel?: RiskLevel;
    agentId?: string;
  }): ApprovalRequest[] {
    return this.approvalQueue.filter((r) => {
      if (r.status !== "pending") return false;
      if (filters?.riskLevel && r.riskLevel !== filters.riskLevel) return false;
      if (filters?.agentId && r.agentId !== filters.agentId) return false;
      return true;
    });
  }

  assignTask(
    agentId: string,
    description: string,
    priority: AgentTask["priority"],
    assignedBy: string,
    requirements?: Record<string, unknown>
  ): AgentTask {
    const agent = this.getAgent(agentId);
    const task: AgentTask = {
      id: generateId("task"),
      description,
      priority,
      assignedBy,
      assignedAt: new Date().toISOString(),
      status: "pending",
      requirements,
    };
    agent.tasks.push(task);
    this.logger.record(assignedBy, "assign-task", description, agentId);
    return task;
  }

  submitReport(
    agentId: string,
    reportType: AgentReport["reportType"],
    summary: string,
    details?: Record<string, unknown>
  ): AgentReport {
    const agent = this.getAgent(agentId);
    const report: AgentReport = {
      id: generateId("report"),
      agentId,
      reportType,
      summary,
      details,
      timestamp: new Date().toISOString(),
    };
    agent.reports.push(report);
    this.logger.record(agentId, "submit-report", summary, undefined, "info");
    return report;
  }

  assignWallet(
    agentId: string,
    wallet: AgentWallet & { privateKey?: string }
  ): AgentWallet {
    const agent = this.getAgent(agentId);
    const stored: AgentWallet = {
      chain: wallet.chain,
      address: wallet.address,
      purpose: wallet.purpose,
      gasAllowance: wallet.gasAllowance,
      encryptedPrivateKey: wallet.privateKey
        ? this.encryption.encrypt(wallet.privateKey)
        : undefined,
    };
    agent.wallets.push(stored);
    this.logger.record(
      "CEO",
      "assign-wallet",
      `${wallet.chain}:${wallet.address}`,
      agentId,
      "info",
      true
    );
    return stored;
  }

  setBudget(agentId: string, budget: AgentBudget): Agent {
    const agent = this.getAgent(agentId);
    agent.budget = { ...(agent.budget ?? {}), ...budget };
    this.logger.record("CEO", "set-budget", JSON.stringify(budget), agentId);
    return agent;
  }

  executeFinancialTransaction(input: FinancialTransactionInput): {
    status: string;
    approvalRequestId?: string;
  } {
    const agent = this.getAgent(input.agentId);
    const hasFinancialPerm = this.checkPermission(
      input.agentId,
      "financial",
      "*"
    );

    if (!hasFinancialPerm) {
      const req = this.requestApproval({
        agentId: input.agentId,
        requestType: "financial_transaction",
        description: `${input.transactionType}: ${JSON.stringify(input.details)}`,
        riskLevel: "high",
        details: input.details,
      });
      return { status: "pending_approval", approvalRequestId: req.id };
    }

    const budget = agent.budget;
    if (budget?.tradingLimit !== undefined) {
      const amount = (input.details.amount as number | undefined) ?? 0;
      if (amount > budget.tradingLimit) {
        throw new Error(
          `Transaction amount ${amount} exceeds trading limit ${budget.tradingLimit}`
        );
      }
    }

    this.logger.record(
      input.agentId,
      "financial-transaction",
      `${input.transactionType}: ${JSON.stringify(input.details)}`,
      undefined,
      "info",
      true
    );
    return { status: "executed" };
  }

  delegateAuthority(
    jrCeoAgentId: string,
    grant: boolean,
    limitations?: string[]
  ): void {
    if (grant) {
      this.jrCeoId = jrCeoAgentId;
      this.logger.record(
        "CEO",
        "delegate-authority",
        `Granted Jr CEO to ${jrCeoAgentId}. Limitations: ${limitations?.join(", ") ?? "none"}`,
        jrCeoAgentId,
        "warn"
      );
    } else {
      this.jrCeoId = null;
      this.logger.record(
        "CEO",
        "revoke-authority",
        `Revoked Jr CEO from ${jrCeoAgentId}`,
        jrCeoAgentId,
        "warn"
      );
    }
  }

  createTeam(
    teamName: string,
    agentTemplates: AgentTemplateKey[],
    mission: string,
    sharedBudget: AgentBudget | undefined,
    createdBy: string
  ): Agent[] {
    const agents = agentTemplates.map((t) =>
      this.spawnAgent({
        template: t,
        createdBy,
        budget: sharedBudget,
        autoStart: true,
      })
    );

    this.logger.record(
      createdBy,
      "create-team",
      `Team "${teamName}" | Mission: ${mission} | Agents: ${agents.map((a) => a.id).join(", ")}`
    );

    return agents;
  }

  getJrCeoId(): string | null {
    return this.jrCeoId;
  }
}
