// external_apis/googleClient.ts — Google APIs (Gmail + Calendar).
// Uses OAuth 2.0 refresh token flow — the bot acts as itself, not a user.

import { google, gmail_v1, calendar_v3 } from 'googleapis';
import { config } from '../config';
import { logger } from '../api/middleware';

function getOAuth2Client() {
  const auth = new google.auth.OAuth2(
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: config.GOOGLE_REFRESH_TOKEN });
  return auth;
}

// ─── Gmail ────────────────────────────────────────────────────────────────────

/**
 * Send an email via the Gmail API.
 * Encodes the RFC 2822 message in base64url as required by the API.
 */
export async function sendGmailMessage(to: string, subject: string, body: string): Promise<{ messageId: string }> {
  const auth  = getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });

  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  ).toString('base64url');

  try {
    const result = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    logger.info('Gmail message sent', { to, subject, messageId: result.data.id });
    return { messageId: result.data.id ?? '' };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Gmail send failed: ${message}`);
  }
}

/**
 * List Gmail messages matching a query.
 */
export async function listGmailMessages(query: string, maxResults = 10): Promise<gmail_v1.Schema$Message[]> {
  const auth  = getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });
  const list  = await gmail.users.messages.list({ userId: 'me', q: query, maxResults });
  return list.data.messages ?? [];
}

// ─── Google Calendar ──────────────────────────────────────────────────────────

/**
 * List upcoming calendar events.
 */
export async function listCalendarEvents(
  maxResults = 10,
  timeMin?: string,
): Promise<calendar_v3.Schema$Event[]> {
  const auth     = getOAuth2Client();
  const calendar = google.calendar({ version: 'v3', auth });

  const response = await calendar.events.list({
    calendarId:   'primary',
    timeMin:      timeMin ?? new Date().toISOString(),
    maxResults,
    singleEvents: true,
    orderBy:      'startTime',
  });

  return response.data.items ?? [];
}

/**
 * Create a Google Calendar event.
 */
export async function createCalendarEvent(
  summary: string,
  start: string,
  end: string,
  description?: string,
): Promise<{ eventId: string; htmlLink: string }> {
  const auth     = getOAuth2Client();
  const calendar = google.calendar({ version: 'v3', auth });

  const response = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary,
      description,
      start: { dateTime: start, timeZone: 'UTC' },
      end:   { dateTime: end,   timeZone: 'UTC' },
    },
  });

  logger.info('Calendar event created', { summary, eventId: response.data.id });
  return { eventId: response.data.id ?? '', htmlLink: response.data.htmlLink ?? '' };
}
