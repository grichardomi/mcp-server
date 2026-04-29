#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const BASE_URL = process.env.FAXSEAL_BASE_URL ?? 'https://faxseal.com';
const API_KEY  = process.env.FAXSEAL_API_KEY ?? '';

if (!API_KEY) {
  process.stderr.write('Error: FAXSEAL_API_KEY environment variable is required.\n');
  process.exit(1);
}

function authHeaders() {
  return {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function apiFetch(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, options);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

const server = new Server(
  { name: 'faxseal-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send_fax',
      description: 'Send a fax from a publicly accessible PDF URL. Returns a job ID for tracking.',
      inputSchema: {
        type: 'object',
        required: ['to', 'file_url'],
        properties: {
          to:           { type: 'string', description: 'Destination fax number in E.164 format, e.g. +12025551234' },
          file_url:     { type: 'string', description: 'Publicly accessible HTTPS URL to a PDF file' },
          from_name:    { type: 'string', description: 'Sender name for the cover page (optional)' },
          from_company: { type: 'string', description: 'Sender company for the cover page (optional)' },
          subject:      { type: 'string', description: 'Fax subject line (optional)' },
          notes:        { type: 'string', description: 'Cover page notes (optional)' },
        },
      },
    },
    {
      name: 'get_fax_status',
      description: 'Check the delivery status of a fax. Status: queued → sending → delivered or failed.',
      inputSchema: {
        type: 'object',
        required: ['job_id'],
        properties: {
          job_id: { type: 'string', description: 'Fax job ID returned by send_fax' },
        },
      },
    },
    {
      name: 'get_credits',
      description: 'Check the current FaxSeal credit balance for this API token.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    if (name === 'send_fax') {
      const data = await apiFetch('/api/zapier/send', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          to:           args.to,
          file_url:     args.file_url,
          from_name:    args.from_name,
          from_company: args.from_company,
          subject:      args.subject,
          notes:        args.notes,
        }),
      });
      return {
        content: [{
          type: 'text',
          text: [
            `✅ Fax queued successfully.`,
            `Job ID: ${data.id}`,
            `To: ${data.to_number}`,
            `Pages: ${data.pages}`,
            `Credits used: ${data.credits_used} (${data.credits_remaining} remaining)`,
            `Track: ${data.track_url}`,
          ].join('\n'),
        }],
      };
    }

    if (name === 'get_fax_status') {
      const data = await apiFetch(`/api/v1/fax/${args.job_id}`, {
        headers: authHeaders(),
      });
      const lines = [
        `Status: ${data.status}`,
        `To: ${data.toNumber}`,
        `Pages: ${data.pages}`,
      ];
      if (data.creditsUsed)    lines.push(`Credits used: ${data.creditsUsed}`);
      if (data.failureReason)  lines.push(`Failure reason: ${data.failureReason}`);
      if (data.certReceiptUrl) lines.push(`Receipt: ${data.certReceiptUrl}`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (name === 'get_credits') {
      const data = await apiFetch('/api/user/credits', { headers: authHeaders() });
      return {
        content: [{ type: 'text', text: `Credit balance: ${data.credits}` }],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
