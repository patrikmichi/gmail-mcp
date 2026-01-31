# Gmail MCP Server

Email management via the Gmail API using the Model Context Protocol.

Inspired by [Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server), rebuilt for Vercel deployment with [mcp-handler](https://github.com/vercel/mcp-handler).

## Quick Start (Use Public Server)

No deployment needed. Just get your OAuth credentials and add them to your MCP client config:

### 1. Create Google Cloud OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or select existing)
3. Enable the **Gmail API** (APIs & Services > Enable APIs)
4. Go to **APIs & Services > Credentials**
5. Click **Create Credentials > OAuth 2.0 Client ID**
6. Application type: **Desktop application**
7. Download the JSON credentials file

### 2. Get Your Refresh Token

Clone this repo and run the setup script:

```bash
pnpm install
pnpm setup path/to/downloaded-credentials.json
```

This will open a browser for Google authorization and output your `mcp.json` configuration.

### 3. Configure MCP Client

Copy the output to `~/.claude/mcp.json` or `.mcp.json`. It will look like:

```json
{
  "mcpServers": {
    "gmail": {
      "url": "https://gmail-mcp.vercel.app/api/mcp",
      "headers": {
        "Authorization": "GMAIL client_id=YOUR_CLIENT_ID&client_secret=YOUR_CLIENT_SECRET&refresh_token=YOUR_REFRESH_TOKEN"
      }
    }
  }
}
```

Your credentials are sent securely over HTTPS and are never stored on the server.

## Self-Hosted (Deploy Your Own)

If you prefer to run your own instance:

1. Click the deploy button below or clone and deploy manually
2. Add the same mcp.json config but with your deployment URL

## Available Tools (24 total)

### Email (6 tools)
- `send_email` - Send an email (with optional attachments)
- `read_email` - Read email by ID
- `search_emails` - Search with Gmail query syntax
- `delete_email` - Permanently delete email
- `trash_email` - Move to trash
- `modify_email` - Modify labels (read/unread, star, archive)

### Attachments (2 tools)
- `list_attachments` - List attachments on an email
- `download_attachment` - Download attachment data (base64)

### Drafts (4 tools)
- `create_draft` - Create a draft
- `list_drafts` - List drafts
- `send_draft` - Send a draft
- `delete_draft` - Delete a draft

### Labels (4 tools)
- `list_labels` - List all labels
- `create_label` - Create a label
- `update_label` - Update a label
- `delete_label` - Delete a label

### Batch Operations (2 tools)
- `batch_modify_emails` - Modify labels on multiple emails
- `batch_delete_emails` - Delete multiple emails

### Filters (3 tools)
- `list_filters` - List all filters
- `create_filter` - Create a filter
- `delete_filter` - Delete a filter

### Threads (2 tools)
- `get_thread` - Get all messages in a thread
- `reply_to_email` - Reply to an email

## Gmail Search Query Examples

The `search_emails` tool supports full Gmail query syntax:

| Query | Description |
|-------|-------------|
| `is:unread` | Unread emails |
| `from:user@example.com` | From specific sender |
| `subject:meeting` | Subject contains "meeting" |
| `has:attachment` | Has attachments |
| `after:2024/01/01` | After date |
| `is:starred` | Starred emails |
| `in:inbox` | In inbox |
| `label:work` | Has label "work" |

## Send-email webhook (any workflow)

Send email with optional attachments from any workflow (cron, n8n, scripts, etc.):

**Endpoint:** `POST /api/send-email`

**Body:** `{ "to", "subject", "body", "attachments": [ { "filename", "mimeType": "application/pdf", "content": "<base64>" } ] }` — omit `attachments` for plain text.

**When self-hosting:** Set env vars on Vercel: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`. Optional: `WEBHOOK_SECRET` — if set, require `Authorization: Bearer <WEBHOOK_SECRET>`. Copy `.env.example` to `.env.local` locally; use Vercel env in production.

**Example (curl):**
```bash
curl -X POST https://your-deploy.vercel.app/api/send-email \
  -H "Content-Type: application/json" \
  -d '{"to":"recipient@example.com","subject":"Subject","body":"Body text","attachments":[]}'
```

## Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/patrikmichi/gmail-mcp)

- **MCP (default):** No env vars required — OAuth credentials are passed via Authorization header. Edit `mcp.json` with your credentials (repo has placeholders). Do not commit real credentials.
- **Send-email webhook:** Set `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` (and optionally `WEBHOOK_SECRET`).

## Security (no real credentials in repo)

- **mcp.json** is in the repo with placeholders only (`YOUR_CLIENT_ID`, etc.). Replace with your real credentials locally and **do not commit** real values.
- **.env.local** is in `.gitignore` — never commit real env values.
- Use **.env.example** as template for webhook env vars.
- OAuth credentials are sent over HTTPS (encrypted in transit).
- The refresh_token allows the server to get short-lived access tokens.
- Revoke access at any time: https://myaccount.google.com/permissions

## Required Gmail API Scopes

- `gmail.modify` - Read, send, delete, and manage emails
- `gmail.compose` - Create and send emails
- `gmail.send` - Send emails
- `gmail.readonly` - Read emails
- `gmail.labels` - Manage labels
- `gmail.settings.basic` - Manage filters
