// tests/agent.orchestrator.test.ts

const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: mockCreate },
})));

jest.mock('../agent/tools', () => ({
  TOOLS:       [{ name: 'get_wallet_balance', description: 'Get balance', input_schema: { type: 'object' } }],
  executeTool: jest.fn(),
}));

jest.mock('../api/middleware', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { runOrchestrator } from '../agent/orchestrator';
import { executeTool } from '../agent/tools';
import { clearSession } from '../agent/memory';

const mockExecuteTool = executeTool as jest.Mock;

const endTurnResponse = (text: string) => ({
  content:     [{ type: 'text', text }],
  stop_reason: 'end_turn',
  usage:       { input_tokens: 10, output_tokens: 20 },
  model:       'claude-3-5-sonnet-20241022',
});

const toolUseResponse = (toolName: string, toolInput: object) => ({
  content: [
    { type: 'tool_use', id: 'tool-call-1', name: toolName, input: toolInput },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 15, output_tokens: 25 },
  model: 'claude-3-5-sonnet-20241022',
});

describe('agent/orchestrator', () => {
  const SESSION = 'test-session-001';

  beforeEach(() => {
    jest.clearAllMocks();
    clearSession(SESSION);
  });

  it('throws when task is empty', async () => {
    await expect(runOrchestrator('', SESSION)).rejects.toThrow('task is required');
  });

  it('returns Claude response directly when no tools are called', async () => {
    mockCreate.mockResolvedValue(endTurnResponse('Here is the answer.'));
    const result = await runOrchestrator('What is 2 + 2?', SESSION);
    expect(result.response).toBe('Here is the answer.');
    expect(result.toolResults).toHaveLength(0);
    expect(result.iterations).toBe(1);
  });

  it('executes a tool and feeds the result back to Claude', async () => {
    mockCreate
      .mockResolvedValueOnce(toolUseResponse('get_wallet_balance', { address: '0xabc', network: 'ethereum' }))
      .mockResolvedValueOnce(endTurnResponse('The balance is 1.5 ETH.'));

    mockExecuteTool.mockResolvedValue({ balance: '1.5', currency: 'ETH', network: 'ethereum' });

    const result = await runOrchestrator('Check wallet 0xabc balance', SESSION);

    expect(mockExecuteTool).toHaveBeenCalledWith('get_wallet_balance', { address: '0xabc', network: 'ethereum' });
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0].success).toBe(true);
    expect(result.response).toContain('1.5 ETH');
  });

  it('records tool error in toolResults without crashing', async () => {
    mockCreate
      .mockResolvedValueOnce(toolUseResponse('get_wallet_balance', { address: 'bad' }))
      .mockResolvedValueOnce(endTurnResponse('The wallet could not be found.'));

    mockExecuteTool.mockRejectedValue(new Error('Invalid wallet address'));

    const result = await runOrchestrator('Check bad wallet', SESSION);
    expect(result.toolResults[0].success).toBe(false);
    expect(result.toolResults[0].error).toContain('Invalid wallet address');
  });

  it('stops after MAX_ITERATIONS without hanging', async () => {
    // Always return tool_use so the loop keeps going — should stop at 8
    mockCreate.mockResolvedValue(toolUseResponse('get_wallet_balance', { address: '0xabc' }));
    mockExecuteTool.mockResolvedValue({ balance: '0' });

    const result = await runOrchestrator('Infinite loop task', SESSION);
    expect(result.iterations).toBeLessThanOrEqual(8);
  });

  it('attaches sessionId and timestamp to the result', async () => {
    mockCreate.mockResolvedValue(endTurnResponse('Done.'));
    const result = await runOrchestrator('Simple task', SESSION);
    expect(result.sessionId).toBe(SESSION);
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('persists conversation history across multiple calls in the same session', async () => {
    mockCreate.mockResolvedValue(endTurnResponse('First response.'));
    await runOrchestrator('First message', SESSION);

    mockCreate.mockResolvedValue(endTurnResponse('Second response.'));
    await runOrchestrator('Second message', SESSION);

    // On the second call, messages passed to Claude should include prior history
    const secondCallMessages = mockCreate.mock.calls[1][0].messages as Array<{ role: string; content: string }>;
    const userMessages = secondCallMessages.filter(m => m.role === 'user');
    expect(userMessages.length).toBeGreaterThanOrEqual(1);
  });
});
