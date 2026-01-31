/**
 * Webhook: send email with optional attachments.
 * Use from any workflow: cron, n8n, scripts, etc.
 *
 * Env (Vercel): GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 * Optional: WEBHOOK_SECRET — if set, require Authorization: Bearer <WEBHOOK_SECRET>
 *
 * POST body: { to, subject, body, attachments?: [{ filename, mimeType, content }] }
 * content = base64-encoded file. Omit attachments for plain text only.
 */

import { NextResponse } from 'next/server';
import { google } from 'googleapis';

export const maxDuration = 60;

interface Attachment {
  filename: string;
  mimeType: string;
  content: string;
}

function encodeBase64Url(data: string): string {
  return Buffer.from(data)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function buildRawEmail(options: {
  to: string;
  subject: string;
  body: string;
  attachments: Attachment[];
}): string {
  const boundary = `boundary_${Date.now()}`;
  const lines: string[] = [];

  lines.push(`To: ${options.to}`);
  lines.push(`Subject: =?UTF-8?B?${Buffer.from(options.subject).toString('base64')}?=`);
  lines.push('MIME-Version: 1.0');
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  lines.push('');

  lines.push(`--${boundary}`);
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  lines.push(Buffer.from(options.body).toString('base64'));

  for (const att of options.attachments) {
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: ${att.mimeType}; name="${att.filename}"`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push(`Content-Disposition: attachment; filename="${att.filename}"`);
    lines.push('');
    lines.push(att.content);
  }
  lines.push(`--${boundary}--`);

  return encodeBase64Url(lines.join('\r\n'));
}

function getCredentialsFromEnv() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Missing GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, or GMAIL_REFRESH_TOKEN. Set them in Vercel env (or .env.local).'
    );
  }
  return { clientId, clientSecret, refreshToken };
}

export async function POST(request: Request) {
  try {
    const secret = process.env.WEBHOOK_SECRET;
    if (secret) {
      const auth = request.headers.get('authorization');
      if (auth !== `Bearer ${secret}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    const payload = await request.json();
    const { to, subject, body: emailBody, attachments } = payload as {
      to?: string;
      subject?: string;
      body?: string;
      attachments?: Attachment[];
    };

    if (!to || !subject || typeof emailBody !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid: to, subject, body' },
        { status: 400 }
      );
    }

    const atts = Array.isArray(attachments) ? attachments : [];
    const creds = getCredentialsFromEnv();

    const oauth2 = new google.auth.OAuth2(
      creds.clientId,
      creds.clientSecret,
      process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/oauth2callback'
    );
    oauth2.setCredentials({ refresh_token: creds.refreshToken });
    const gmail = google.gmail({ version: 'v1', auth: oauth2 });

    const raw = buildRawEmail({
      to,
      subject,
      body: emailBody,
      attachments: atts,
    });

    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });

    return NextResponse.json({
      ok: true,
      messageId: result.data.id,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('send-email error:', message);
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
