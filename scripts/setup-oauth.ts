/**
 * Gmail OAuth Setup Script
 *
 * This script helps you obtain the refresh_token needed for the Gmail MCP server.
 *
 * Prerequisites:
 * 1. Create a Google Cloud project at https://console.cloud.google.com
 * 2. Enable the Gmail API
 * 3. Create OAuth 2.0 credentials (Desktop application)
 * 4. Download the credentials JSON file
 *
 * Usage:
 *   npx tsx scripts/setup-oauth.ts path/to/credentials.json
 */

import { google } from 'googleapis';
import * as http from 'http';
import * as url from 'url';
import * as fs from 'fs';
import * as path from 'path';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/gmail.settings.basic',
];

const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

async function main() {
  const credentialsPath = process.argv[2];

  if (!credentialsPath) {
    console.error('\nUsage: npx tsx scripts/setup-oauth.ts <path-to-credentials.json>\n');
    console.error('Steps:');
    console.error('  1. Go to https://console.cloud.google.com/apis/credentials');
    console.error('  2. Create OAuth 2.0 Client ID (Desktop application)');
    console.error('  3. Download the JSON file');
    console.error('  4. Run this script with the path to that file\n');
    process.exit(1);
  }

  const absolutePath = path.resolve(credentialsPath);

  if (!fs.existsSync(absolutePath)) {
    console.error(`\nError: File not found: ${absolutePath}\n`);
    process.exit(1);
  }

  const credentials = JSON.parse(fs.readFileSync(absolutePath, 'utf-8'));
  const clientConfig = credentials.installed || credentials.web;

  if (!clientConfig) {
    console.error('\nError: Invalid credentials file. Must contain "installed" or "web" key.\n');
    process.exit(1);
  }

  const { client_id, client_secret } = clientConfig;

  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('\n=== Gmail MCP OAuth Setup ===\n');
  console.log('Opening browser for authorization...\n');
  console.log('If the browser does not open, visit this URL:\n');
  console.log(authUrl);
  console.log('');

  // Open browser
  const { exec } = await import('child_process');
  const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${openCmd} "${authUrl}"`);

  // Start local server to capture callback
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const parsedUrl = url.parse(req.url || '', true);

      if (parsedUrl.pathname === '/oauth2callback') {
        const authCode = parsedUrl.query.code as string;

        if (authCode) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>Authorization successful!</h1><p>You can close this window.</p></body></html>');
          server.close();
          resolve(authCode);
        } else {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<html><body><h1>Error</h1><p>No authorization code received.</p></body></html>');
          server.close();
          reject(new Error('No authorization code'));
        }
      }
    });

    server.listen(PORT, () => {
      console.log(`Waiting for authorization callback on port ${PORT}...\n`);
    });

    server.on('error', (err) => {
      reject(new Error(`Server error: ${err.message}. Is port ${PORT} already in use?`));
    });
  });

  // Exchange code for tokens
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    console.error('\nError: No refresh token received. Try revoking access at https://myaccount.google.com/permissions and run again.\n');
    process.exit(1);
  }

  console.log('\n=== Setup Complete ===\n');
  console.log('Add this to your ~/.claude/mcp.json:\n');
  console.log(JSON.stringify({
    mcpServers: {
      gmail: {
        url: 'https://gmail-mcp.vercel.app/api/mcp',
        headers: {
          Authorization: `GMAIL client_id=${client_id}&client_secret=${client_secret}&refresh_token=${tokens.refresh_token}`,
        },
      },
    },
  }, null, 2));
  console.log('');

  // Also save credentials locally for reference
  const outputPath = path.join(process.cwd(), '.gmail-credentials.json');
  fs.writeFileSync(outputPath, JSON.stringify({
    client_id,
    client_secret,
    refresh_token: tokens.refresh_token,
  }, null, 2));
  console.log(`Credentials also saved to: ${outputPath}`);
  console.log('(Add .gmail-credentials.json to .gitignore!)\n');
}

main().catch(console.error);
