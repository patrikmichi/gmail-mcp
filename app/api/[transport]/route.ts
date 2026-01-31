/**
 * Gmail MCP Server
 *
 * Email management via the Gmail API using the Model Context Protocol.
 * Authentication: Pass OAuth credentials via Authorization header.
 * Format: GMAIL client_id=XXX&client_secret=XXX&refresh_token=XXX
 */

import { z } from 'zod';
import { createMcpHandler } from 'mcp-handler';
import { headers } from 'next/headers';
import { google } from 'googleapis';

export const maxDuration = 60;

// ============================================================================
// Authentication
// ============================================================================

interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

async function getCredentials(): Promise<OAuthCredentials> {
  const headersList = await headers();
  const authHeader = headersList.get('authorization');

  if (!authHeader?.startsWith('GMAIL ')) {
    throw new Error(
      'Gmail MCP requires OAuth credentials. ' +
      'Pass via Authorization header: ' +
      'GMAIL client_id=YOUR_CLIENT_ID&client_secret=YOUR_CLIENT_SECRET&refresh_token=YOUR_REFRESH_TOKEN\n\n' +
      'Run "pnpm setup" to generate credentials.'
    );
  }

  const params = new URLSearchParams(authHeader.slice(6));
  const clientId = params.get('client_id');
  const clientSecret = params.get('client_secret');
  const refreshToken = params.get('refresh_token');

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing required credentials: client_id, client_secret, and refresh_token');
  }

  return { clientId, clientSecret, refreshToken };
}

async function getGmailClient() {
  const creds = await getCredentials();

  const oauth2Client = new google.auth.OAuth2(
    creds.clientId,
    creds.clientSecret,
    'http://localhost:3000/oauth2callback'
  );

  oauth2Client.setCredentials({
    refresh_token: creds.refreshToken,
  });

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// ============================================================================
// Helpers
// ============================================================================

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

function encodeBase64Url(data: string): string {
  return Buffer.from(data)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function getHeader(headers: Array<{ name?: string | null; value?: string | null }>, name: string): string {
  const header = headers.find(h => h.name?.toLowerCase() === name.toLowerCase());
  return header?.value || '';
}

interface Attachment {
  filename: string;
  mimeType: string;
  content: string; // base64 encoded
}

function buildRawEmail(options: {
  to: string;
  subject: string;
  body: string;
  htmlBody?: string;
  cc?: string[];
  bcc?: string[];
  from?: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: Attachment[];
}): string {
  const boundary = `boundary_${Date.now()}`;
  const altBoundary = `alt_boundary_${Date.now()}`;
  const lines: string[] = [];

  lines.push(`To: ${options.to}`);
  if (options.from) lines.push(`From: ${options.from}`);
  if (options.cc?.length) lines.push(`Cc: ${options.cc.join(', ')}`);
  if (options.bcc?.length) lines.push(`Bcc: ${options.bcc.join(', ')}`);
  lines.push(`Subject: =?UTF-8?B?${Buffer.from(options.subject).toString('base64')}?=`);
  if (options.inReplyTo) lines.push(`In-Reply-To: ${options.inReplyTo}`);
  if (options.references) lines.push(`References: ${options.references}`);
  lines.push('MIME-Version: 1.0');

  if (options.attachments?.length) {
    // Multipart/mixed for attachments
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    lines.push('');

    // Body part
    lines.push(`--${boundary}`);
    if (options.htmlBody) {
      lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
      lines.push('');
      lines.push(`--${altBoundary}`);
      lines.push('Content-Type: text/plain; charset="UTF-8"');
      lines.push('Content-Transfer-Encoding: base64');
      lines.push('');
      lines.push(Buffer.from(options.body).toString('base64'));
      lines.push(`--${altBoundary}`);
      lines.push('Content-Type: text/html; charset="UTF-8"');
      lines.push('Content-Transfer-Encoding: base64');
      lines.push('');
      lines.push(Buffer.from(options.htmlBody).toString('base64'));
      lines.push(`--${altBoundary}--`);
    } else {
      lines.push('Content-Type: text/plain; charset="UTF-8"');
      lines.push('Content-Transfer-Encoding: base64');
      lines.push('');
      lines.push(Buffer.from(options.body).toString('base64'));
    }

    // Attachment parts
    for (const att of options.attachments) {
      lines.push(`--${boundary}`);
      lines.push(`Content-Type: ${att.mimeType}; name="${att.filename}"`);
      lines.push('Content-Transfer-Encoding: base64');
      lines.push(`Content-Disposition: attachment; filename="${att.filename}"`);
      lines.push('');
      lines.push(att.content);
    }
    lines.push(`--${boundary}--`);
  } else if (options.htmlBody) {
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    lines.push(Buffer.from(options.body).toString('base64'));
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/html; charset="UTF-8"');
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    lines.push(Buffer.from(options.htmlBody).toString('base64'));
    lines.push(`--${boundary}--`);
  } else {
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push('Content-Transfer-Encoding: base64');
    lines.push('');
    lines.push(Buffer.from(options.body).toString('base64'));
  }

  return encodeBase64Url(lines.join('\r\n'));
}

interface ParsedMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  body: string;
  labels: string[];
}

function parseMessage(message: Record<string, unknown>): ParsedMessage {
  const payload = message.payload as Record<string, unknown> | undefined;
  const msgHeaders = (payload?.headers as Array<{ name?: string | null; value?: string | null }>) || [];

  let body = '';
  if (payload) {
    const parts = payload.parts as Array<Record<string, unknown>> | undefined;
    if (parts) {
      const textPart = parts.find(p => (p.mimeType as string) === 'text/plain');
      const htmlPart = parts.find(p => (p.mimeType as string) === 'text/html');
      const part = textPart || htmlPart;
      if (part) {
        const partBody = part.body as Record<string, unknown> | undefined;
        const data = partBody?.data as string | undefined;
        if (data) {
          body = decodeBase64Url(data);
        }
      }
    } else {
      const payloadBody = payload.body as Record<string, unknown> | undefined;
      const data = payloadBody?.data as string | undefined;
      if (data) {
        body = decodeBase64Url(data);
      }
    }
  }

  return {
    id: message.id as string,
    threadId: message.threadId as string,
    from: getHeader(msgHeaders, 'From'),
    to: getHeader(msgHeaders, 'To'),
    subject: getHeader(msgHeaders, 'Subject'),
    date: getHeader(msgHeaders, 'Date'),
    snippet: message.snippet as string || '',
    body,
    labels: (message.labelIds as string[]) || [],
  };
}

// ============================================================================
// MCP Handler
// ============================================================================

const handler = createMcpHandler(
  (server) => {
    // ========================================================================
    // Email Tools
    // ========================================================================

    server.tool(
      'send_email',
      'Send an email with optional attachments',
      {
        to: z.string().describe('Recipient email address'),
        subject: z.string().describe('Email subject'),
        body: z.string().describe('Plain text body'),
        htmlBody: z.string().optional().describe('HTML body (optional)'),
        cc: z.array(z.string()).optional().describe('CC recipients'),
        bcc: z.array(z.string()).optional().describe('BCC recipients'),
        threadId: z.string().optional().describe('Thread ID to reply to'),
        attachments: z.array(z.object({
          filename: z.string().describe('File name (e.g., "report.pdf")'),
          mimeType: z.string().describe('MIME type (e.g., "application/pdf", "image/png")'),
          content: z.string().describe('File content as base64 encoded string'),
        })).optional().describe('File attachments (base64 encoded)'),
      },
      async ({ to, subject, body, htmlBody, cc, bcc, threadId, attachments }) => {
        const gmail = await getGmailClient();

        const raw = buildRawEmail({ to, subject, body, htmlBody, cc, bcc, attachments });

        const result = await gmail.users.messages.send({
          userId: 'me',
          requestBody: {
            raw,
            ...(threadId && { threadId }),
          },
        });

        return {
          content: [{ type: 'text', text: `Email sent successfully. Message ID: ${result.data.id}` }],
        };
      }
    );

    server.tool(
      'read_email',
      'Read a specific email by ID',
      {
        messageId: z.string().describe('The message ID'),
      },
      async ({ messageId }) => {
        const gmail = await getGmailClient();

        const result = await gmail.users.messages.get({
          userId: 'me',
          id: messageId,
          format: 'full',
        });

        const parsed = parseMessage(result.data as Record<string, unknown>);
        return {
          content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
        };
      }
    );

    server.tool(
      'search_emails',
      'Search emails using Gmail query syntax',
      {
        query: z.string().describe('Gmail search query (e.g., "from:user@example.com", "is:unread", "subject:hello")'),
        maxResults: z.number().optional().describe('Maximum results to return (default: 10, max: 100)'),
      },
      async ({ query, maxResults }) => {
        const gmail = await getGmailClient();

        const listResult = await gmail.users.messages.list({
          userId: 'me',
          q: query,
          maxResults: Math.min(maxResults || 10, 100),
        });

        const messages = listResult.data.messages || [];

        if (messages.length === 0) {
          return {
            content: [{ type: 'text', text: 'No emails found matching your query.' }],
          };
        }

        const results: ParsedMessage[] = [];
        for (const msg of messages) {
          const detail = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id!,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Subject', 'Date'],
          });

          const data = detail.data as Record<string, unknown>;
          const payload = data.payload as Record<string, unknown> | undefined;
          const msgHeaders = (payload?.headers as Array<{ name?: string | null; value?: string | null }>) || [];

          results.push({
            id: data.id as string,
            threadId: data.threadId as string,
            from: getHeader(msgHeaders, 'From'),
            to: getHeader(msgHeaders, 'To'),
            subject: getHeader(msgHeaders, 'Subject'),
            date: getHeader(msgHeaders, 'Date'),
            snippet: data.snippet as string || '',
            body: '',
            labels: (data.labelIds as string[]) || [],
          });
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
        };
      }
    );

    server.tool(
      'delete_email',
      'Permanently delete an email (cannot be undone)',
      {
        messageId: z.string().describe('The message ID to delete'),
      },
      async ({ messageId }) => {
        const gmail = await getGmailClient();

        await gmail.users.messages.delete({
          userId: 'me',
          id: messageId,
        });

        return {
          content: [{ type: 'text', text: `Email ${messageId} permanently deleted.` }],
        };
      }
    );

    server.tool(
      'trash_email',
      'Move an email to trash',
      {
        messageId: z.string().describe('The message ID to trash'),
      },
      async ({ messageId }) => {
        const gmail = await getGmailClient();

        await gmail.users.messages.trash({
          userId: 'me',
          id: messageId,
        });

        return {
          content: [{ type: 'text', text: `Email ${messageId} moved to trash.` }],
        };
      }
    );

    server.tool(
      'modify_email',
      'Modify email labels (mark as read/unread, star, archive, etc.)',
      {
        messageId: z.string().describe('The message ID'),
        addLabels: z.array(z.string()).optional().describe('Labels to add (e.g., "STARRED", "IMPORTANT", "UNREAD")'),
        removeLabels: z.array(z.string()).optional().describe('Labels to remove (e.g., "UNREAD", "INBOX")'),
      },
      async ({ messageId, addLabels, removeLabels }) => {
        const gmail = await getGmailClient();

        const result = await gmail.users.messages.modify({
          userId: 'me',
          id: messageId,
          requestBody: {
            addLabelIds: addLabels,
            removeLabelIds: removeLabels,
          },
        });

        return {
          content: [{ type: 'text', text: `Email modified. Labels: ${(result.data.labelIds || []).join(', ')}` }],
        };
      }
    );

    // ========================================================================
    // Attachment Tools
    // ========================================================================

    server.tool(
      'list_attachments',
      'List attachments on an email',
      {
        messageId: z.string().describe('The message ID'),
      },
      async ({ messageId }) => {
        const gmail = await getGmailClient();

        const result = await gmail.users.messages.get({
          userId: 'me',
          id: messageId,
          format: 'full',
        });

        const payload = result.data.payload;
        const attachments: Array<{ id: string; filename: string; mimeType: string; size: number }> = [];

        function findAttachments(parts: NonNullable<typeof payload>['parts']) {
          if (!parts) return;
          for (const part of parts) {
            if (part.filename && part.body?.attachmentId) {
              attachments.push({
                id: part.body.attachmentId,
                filename: part.filename,
                mimeType: part.mimeType || 'application/octet-stream',
                size: part.body.size || 0,
              });
            }
            if (part.parts) {
              findAttachments(part.parts);
            }
          }
        }

        findAttachments(payload?.parts);

        if (attachments.length === 0) {
          return {
            content: [{ type: 'text', text: 'No attachments found on this message.' }],
          };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(attachments, null, 2) }],
        };
      }
    );

    server.tool(
      'download_attachment',
      'Download an attachment from an email (returns base64 data)',
      {
        messageId: z.string().describe('The message ID'),
        attachmentId: z.string().describe('The attachment ID (from list_attachments)'),
      },
      async ({ messageId, attachmentId }) => {
        const gmail = await getGmailClient();

        const result = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId,
          id: attachmentId,
        });

        const data = result.data.data;
        if (!data) {
          throw new Error('No attachment data returned');
        }

        // Gmail returns URL-safe base64, convert to standard base64
        const base64Data = data.replace(/-/g, '+').replace(/_/g, '/');

        return {
          content: [{ type: 'text', text: JSON.stringify({ attachmentId, base64: base64Data, sizeBytes: result.data.size }, null, 2) }],
        };
      }
    );

    // ========================================================================
    // Draft Tools
    // ========================================================================

    server.tool(
      'create_draft',
      'Create an email draft',
      {
        to: z.string().describe('Recipient email address'),
        subject: z.string().describe('Email subject'),
        body: z.string().describe('Plain text body'),
        htmlBody: z.string().optional().describe('HTML body (optional)'),
        cc: z.array(z.string()).optional().describe('CC recipients'),
        bcc: z.array(z.string()).optional().describe('BCC recipients'),
      },
      async ({ to, subject, body, htmlBody, cc, bcc }) => {
        const gmail = await getGmailClient();

        const raw = buildRawEmail({ to, subject, body, htmlBody, cc, bcc });

        const result = await gmail.users.drafts.create({
          userId: 'me',
          requestBody: {
            message: { raw },
          },
        });

        return {
          content: [{ type: 'text', text: `Draft created. Draft ID: ${result.data.id}` }],
        };
      }
    );

    server.tool(
      'list_drafts',
      'List email drafts',
      {
        maxResults: z.number().optional().describe('Maximum results (default: 10)'),
      },
      async ({ maxResults }) => {
        const gmail = await getGmailClient();

        const result = await gmail.users.drafts.list({
          userId: 'me',
          maxResults: maxResults || 10,
        });

        const drafts = result.data.drafts || [];

        if (drafts.length === 0) {
          return {
            content: [{ type: 'text', text: 'No drafts found.' }],
          };
        }

        const details = [];
        for (const draft of drafts) {
          const detail = await gmail.users.drafts.get({
            userId: 'me',
            id: draft.id!,
            format: 'metadata',
          });

          const msg = detail.data.message as Record<string, unknown> | undefined;
          const payload = msg?.payload as Record<string, unknown> | undefined;
          const msgHeaders = (payload?.headers as Array<{ name?: string | null; value?: string | null }>) || [];

          details.push({
            draftId: draft.id,
            messageId: msg?.id,
            to: getHeader(msgHeaders, 'To'),
            subject: getHeader(msgHeaders, 'Subject'),
            date: getHeader(msgHeaders, 'Date'),
          });
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(details, null, 2) }],
        };
      }
    );

    server.tool(
      'send_draft',
      'Send an existing draft',
      {
        draftId: z.string().describe('The draft ID to send'),
      },
      async ({ draftId }) => {
        const gmail = await getGmailClient();

        const result = await gmail.users.drafts.send({
          userId: 'me',
          requestBody: { id: draftId },
        });

        return {
          content: [{ type: 'text', text: `Draft sent. Message ID: ${result.data.id}` }],
        };
      }
    );

    server.tool(
      'delete_draft',
      'Delete a draft',
      {
        draftId: z.string().describe('The draft ID to delete'),
      },
      async ({ draftId }) => {
        const gmail = await getGmailClient();

        await gmail.users.drafts.delete({
          userId: 'me',
          id: draftId,
        });

        return {
          content: [{ type: 'text', text: `Draft ${draftId} deleted.` }],
        };
      }
    );

    // ========================================================================
    // Label Tools
    // ========================================================================

    server.tool(
      'list_labels',
      'List all Gmail labels',
      {},
      async () => {
        const gmail = await getGmailClient();

        const result = await gmail.users.labels.list({
          userId: 'me',
        });

        const labels = (result.data.labels || []).map(l => ({
          id: l.id,
          name: l.name,
          type: l.type,
          messagesTotal: l.messagesTotal,
          messagesUnread: l.messagesUnread,
        }));

        return {
          content: [{ type: 'text', text: JSON.stringify(labels, null, 2) }],
        };
      }
    );

    server.tool(
      'create_label',
      'Create a new Gmail label',
      {
        name: z.string().describe('Label name'),
        messageListVisibility: z.enum(['show', 'hide']).optional().describe('Show in message list'),
        labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe('Show in label list'),
      },
      async ({ name, messageListVisibility, labelListVisibility }) => {
        const gmail = await getGmailClient();

        const result = await gmail.users.labels.create({
          userId: 'me',
          requestBody: {
            name,
            messageListVisibility: messageListVisibility || 'show',
            labelListVisibility: labelListVisibility || 'labelShow',
          },
        });

        return {
          content: [{ type: 'text', text: `Label created: ${result.data.name} (ID: ${result.data.id})` }],
        };
      }
    );

    server.tool(
      'update_label',
      'Update a Gmail label',
      {
        labelId: z.string().describe('Label ID'),
        name: z.string().optional().describe('New label name'),
        messageListVisibility: z.enum(['show', 'hide']).optional().describe('Show in message list'),
        labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional().describe('Show in label list'),
      },
      async ({ labelId, name, messageListVisibility, labelListVisibility }) => {
        const gmail = await getGmailClient();

        const result = await gmail.users.labels.update({
          userId: 'me',
          id: labelId,
          requestBody: {
            id: labelId,
            ...(name && { name }),
            ...(messageListVisibility && { messageListVisibility }),
            ...(labelListVisibility && { labelListVisibility }),
          },
        });

        return {
          content: [{ type: 'text', text: `Label updated: ${result.data.name}` }],
        };
      }
    );

    server.tool(
      'delete_label',
      'Delete a Gmail label',
      {
        labelId: z.string().describe('Label ID to delete'),
      },
      async ({ labelId }) => {
        const gmail = await getGmailClient();

        await gmail.users.labels.delete({
          userId: 'me',
          id: labelId,
        });

        return {
          content: [{ type: 'text', text: `Label ${labelId} deleted.` }],
        };
      }
    );

    // ========================================================================
    // Batch Tools
    // ========================================================================

    server.tool(
      'batch_modify_emails',
      'Modify labels on multiple emails at once',
      {
        messageIds: z.array(z.string()).describe('Array of message IDs (max 50)'),
        addLabels: z.array(z.string()).optional().describe('Labels to add'),
        removeLabels: z.array(z.string()).optional().describe('Labels to remove'),
      },
      async ({ messageIds, addLabels, removeLabels }) => {
        const gmail = await getGmailClient();

        const ids = messageIds.slice(0, 50);

        await gmail.users.messages.batchModify({
          userId: 'me',
          requestBody: {
            ids,
            addLabelIds: addLabels,
            removeLabelIds: removeLabels,
          },
        });

        return {
          content: [{ type: 'text', text: `Batch modified ${ids.length} emails.` }],
        };
      }
    );

    server.tool(
      'batch_delete_emails',
      'Permanently delete multiple emails (cannot be undone)',
      {
        messageIds: z.array(z.string()).describe('Array of message IDs to delete (max 50)'),
      },
      async ({ messageIds }) => {
        const gmail = await getGmailClient();

        const ids = messageIds.slice(0, 50);

        await gmail.users.messages.batchDelete({
          userId: 'me',
          requestBody: { ids },
        });

        return {
          content: [{ type: 'text', text: `Batch deleted ${ids.length} emails.` }],
        };
      }
    );

    // ========================================================================
    // Filter Tools
    // ========================================================================

    server.tool(
      'list_filters',
      'List all Gmail filters',
      {},
      async () => {
        const gmail = await getGmailClient();

        const result = await gmail.users.settings.filters.list({
          userId: 'me',
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(result.data.filter || [], null, 2) }],
        };
      }
    );

    server.tool(
      'create_filter',
      'Create a Gmail filter',
      {
        from: z.string().optional().describe('From address to match'),
        to: z.string().optional().describe('To address to match'),
        subject: z.string().optional().describe('Subject to match'),
        query: z.string().optional().describe('Gmail search query to match'),
        addLabelIds: z.array(z.string()).optional().describe('Labels to add'),
        removeLabelIds: z.array(z.string()).optional().describe('Labels to remove'),
        forward: z.string().optional().describe('Email to forward to'),
        star: z.boolean().optional().describe('Star matching messages'),
        markImportant: z.boolean().optional().describe('Mark as important'),
        markRead: z.boolean().optional().describe('Mark as read'),
        archive: z.boolean().optional().describe('Skip inbox (archive)'),
        trash: z.boolean().optional().describe('Move to trash'),
      },
      async ({ from, to, subject, query, addLabelIds, removeLabelIds, forward, star, markImportant, markRead, archive, trash }) => {
        const gmail = await getGmailClient();

        const criteria: Record<string, unknown> = {};
        if (from) criteria.from = from;
        if (to) criteria.to = to;
        if (subject) criteria.subject = subject;
        if (query) criteria.query = query;

        const action: Record<string, unknown> = {};
        if (addLabelIds) action.addLabelIds = addLabelIds;
        if (removeLabelIds) action.removeLabelIds = removeLabelIds;
        if (forward) action.forward = forward;

        // Map boolean actions to removeLabelIds
        const removeIds = [...(removeLabelIds || [])];
        if (markRead) removeIds.push('UNREAD');
        if (archive) removeIds.push('INBOX');
        if (trash) action.addLabelIds = [...(addLabelIds || []), 'TRASH'];
        if (removeIds.length) action.removeLabelIds = removeIds;

        const addIds = [...(addLabelIds || [])];
        if (star) addIds.push('STARRED');
        if (markImportant) addIds.push('IMPORTANT');
        if (addIds.length) action.addLabelIds = addIds;

        const result = await gmail.users.settings.filters.create({
          userId: 'me',
          requestBody: { criteria, action },
        });

        return {
          content: [{ type: 'text', text: `Filter created. ID: ${result.data.id}` }],
        };
      }
    );

    server.tool(
      'delete_filter',
      'Delete a Gmail filter',
      {
        filterId: z.string().describe('Filter ID to delete'),
      },
      async ({ filterId }) => {
        const gmail = await getGmailClient();

        await gmail.users.settings.filters.delete({
          userId: 'me',
          id: filterId,
        });

        return {
          content: [{ type: 'text', text: `Filter ${filterId} deleted.` }],
        };
      }
    );

    // ========================================================================
    // Thread Tools
    // ========================================================================

    server.tool(
      'get_thread',
      'Get all messages in a thread',
      {
        threadId: z.string().describe('Thread ID'),
      },
      async ({ threadId }) => {
        const gmail = await getGmailClient();

        const result = await gmail.users.threads.get({
          userId: 'me',
          id: threadId,
          format: 'full',
        });

        const messages = (result.data.messages || []).map(msg =>
          parseMessage(msg as Record<string, unknown>)
        );

        return {
          content: [{ type: 'text', text: JSON.stringify(messages, null, 2) }],
        };
      }
    );

    server.tool(
      'reply_to_email',
      'Reply to an email in a thread',
      {
        messageId: z.string().describe('Message ID to reply to'),
        body: z.string().describe('Reply body (plain text)'),
        htmlBody: z.string().optional().describe('Reply body (HTML, optional)'),
        replyAll: z.boolean().optional().describe('Reply to all recipients'),
      },
      async ({ messageId, body, htmlBody, replyAll }) => {
        const gmail = await getGmailClient();

        // Get original message for headers
        const original = await gmail.users.messages.get({
          userId: 'me',
          id: messageId,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Message-ID', 'References'],
        });

        const origData = original.data as Record<string, unknown>;
        const payload = origData.payload as Record<string, unknown> | undefined;
        const msgHeaders = (payload?.headers as Array<{ name?: string | null; value?: string | null }>) || [];

        const from = getHeader(msgHeaders, 'From');
        const to = getHeader(msgHeaders, 'To');
        const cc = getHeader(msgHeaders, 'Cc');
        const origSubject = getHeader(msgHeaders, 'Subject');
        const messageIdHeader = getHeader(msgHeaders, 'Message-ID');
        const references = getHeader(msgHeaders, 'References');

        // Determine reply recipients
        const replyTo = from;
        const replyCc = replyAll ? [to, cc].filter(Boolean) : undefined;

        const subject = origSubject.startsWith('Re:') ? origSubject : `Re: ${origSubject}`;

        const raw = buildRawEmail({
          to: replyTo,
          subject,
          body,
          htmlBody,
          cc: replyCc,
          inReplyTo: messageIdHeader,
          references: references ? `${references} ${messageIdHeader}` : messageIdHeader,
        });

        const result = await gmail.users.messages.send({
          userId: 'me',
          requestBody: {
            raw,
            threadId: origData.threadId as string,
          },
        });

        return {
          content: [{ type: 'text', text: `Reply sent. Message ID: ${result.data.id}` }],
        };
      }
    );
  },
  {},
  { basePath: '/api' }
);

export { handler as GET, handler as POST, handler as DELETE };
