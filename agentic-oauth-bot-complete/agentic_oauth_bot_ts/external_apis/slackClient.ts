// external_apis/slackClient.ts — Slack Web API integration.
// Sends messages, uploads files, and reads channel history.

import { WebClient } from '@slack/web-api';
import { config } from '../config';
import { logger } from '../api/middleware';

let _slack: WebClient | null = null;

function getSlack(): WebClient {
  if (!_slack) _slack = new WebClient(config.SLACK_BOT_TOKEN);
  return _slack;
}

/**
 * Post a message to a Slack channel.
 */
export async function sendSlackMessage(channel: string, text: string): Promise<{ ts: string; channel: string }> {
  try {
    const result = await getSlack().chat.postMessage({ channel, text });
    if (!result.ok) throw new Error(result.error ?? 'Unknown Slack error');
    logger.info('Slack message sent', { channel, ts: result.ts });
    return { ts: result.ts ?? '', channel: result.channel ?? channel };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Slack send failed: ${message}`);
  }
}

/**
 * Post a rich Slack message with Block Kit blocks.
 */
export async function sendSlackBlocks(
  channel: string,
  text: string,
  blocks: object[],
): Promise<{ ts: string; channel: string }> {
  try {
    const result = await getSlack().chat.postMessage({ channel, text, blocks });
    if (!result.ok) throw new Error(result.error ?? 'Slack error');
    return { ts: result.ts ?? '', channel: result.channel ?? channel };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Slack blocks send failed: ${message}`);
  }
}

/**
 * Fetch recent messages from a channel.
 */
export async function getChannelHistory(channel: string, limit = 10): Promise<object[]> {
  const result = await getSlack().conversations.history({ channel, limit });
  if (!result.ok) throw new Error(result.error ?? 'Slack history error');
  return result.messages ?? [];
}
