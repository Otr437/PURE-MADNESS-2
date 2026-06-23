import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { db, queries, logEntry } from "../db/index.js";
import { authenticateToken } from "../middleware/auth.js";
import { callAI } from "../services/ai.js";
import { broadcast }              from "../websocket/index.js";
import { longTermQuery, longTermSerialize } from "../services/memory/longTerm.js";

const router = Router();
router.use(authenticateToken);

// GET /api/chat/:sessionId  — full conversation history
router.get("/:sessionId", (req: Request, res: Response) => {
  const messages = queries.getChatHistory.all(req.params.sessionId) as any[];
  return res.json(messages);
});

// POST /api/chat/:sessionId  — send a message, get AI response
router.post("/:sessionId", async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const { content, agent_id } = req.body;

  if (!content || !content.trim()) {
    return res.status(400).json({ error: "content is required" });
  }

  // Persist the user message
  const userMsgId = uuidv4();
  queries.insertChatMessage.run(userMsgId, sessionId, "user", content.trim(), agent_id || null);

  const userMsg = { id: userMsgId, session_id: sessionId, role: "user", content: content.trim(), agent_id: agent_id || null, created_at: new Date().toISOString() };
  broadcast("CHAT_MESSAGE", userMsg);

  // Build conversation history for context window
  const history = (queries.getChatHistory.all(sessionId) as any[]).map((m: any) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  // Determine which agent/model to use
  let provider: string  = "anthropic";
  let model: string     = "claude-sonnet-4-6";
  let systemPrompt: string = `You are AgentNest Pro, an advanced AI assistant and agent orchestration system. Today is ${new Date().toLocaleDateString()}. You help users manage AI agents, workflows, and tasks. Be concise, accurate, and helpful.`;

  if (agent_id) {
    const agent = queries.getAgentById.get(agent_id) as any;
    if (agent) {
      provider     = agent.provider;
      model        = agent.model;
      systemPrompt = agent.system_prompt || systemPrompt;
    }
  }

  // Inject relevant long-term memory into the system prompt if an agent is active
  if (agent_id) {
    const lastUserMsg  = content.trim();
    const memories     = longTermQuery(agent_id, lastUserMsg, 5);
    const memoryBlock  = longTermSerialize(memories);
    if (memoryBlock) {
      systemPrompt += `\n\n## Relevant Memory from Past Tasks\n${memoryBlock}`;
    }
  }

  try {
    const aiResponse = await callAI({
      provider:    provider as any,
      model,
      systemPrompt,
      messages:    history,
      maxTokens:   2048,
      agentId:     agent_id || undefined,
    });

    // Persist AI response
    const aiMsgId = uuidv4();
    queries.insertChatMessage.run(aiMsgId, sessionId, "assistant", aiResponse, agent_id || null);

    const aiMsg = { id: aiMsgId, session_id: sessionId, role: "assistant", content: aiResponse, agent_id: agent_id || null, created_at: new Date().toISOString() };
    broadcast("CHAT_MESSAGE", aiMsg);

    return res.json({ userMessage: userMsg, aiMessage: aiMsg });

  } catch (err: any) {
    // Still return the user message even if AI fails, with error info
    const errorMsgId = uuidv4();
    const errorContent = `Error: ${err.message}. Please check your API key configuration in Settings.`;
    queries.insertChatMessage.run(errorMsgId, sessionId, "assistant", errorContent, null);

    const errorMsg = { id: errorMsgId, session_id: sessionId, role: "assistant", content: errorContent, agent_id: null, created_at: new Date().toISOString() };
    broadcast("CHAT_MESSAGE", errorMsg);

    return res.status(200).json({ userMessage: userMsg, aiMessage: errorMsg, error: err.message });
  }
});

// DELETE /api/chat/:sessionId  — clear a session's history
router.delete("/:sessionId", (req: Request, res: Response) => {
  queries.clearChatSession.run(req.params.sessionId);
  broadcast("CHAT_CLEARED", { session_id: req.params.sessionId });
  return res.json({ success: true });
});

// GET /api/chat/sessions/list  — list all unique session IDs with message counts
router.get("/sessions/list", (_req: Request, res: Response) => {
  const rows = db.prepare(`
    SELECT session_id,
           COUNT(*) as message_count,
           MIN(created_at) as started_at,
           MAX(created_at) as last_message_at,
           agent_id
    FROM chat_messages
    GROUP BY session_id
    ORDER BY last_message_at DESC
    LIMIT 50
  `).all();
  return res.json(rows);
});

export { router as chatRouter };
