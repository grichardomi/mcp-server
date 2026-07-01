#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const BASE_URL = (process.env.FAXSEAL_BASE_URL ?? 'https://faxseal.com').replace(/\/+$/, '');
const API_KEY  = process.env.FAXSEAL_API_KEY ?? '';
const FETCH_TIMEOUT_MS = 30_000;
const SERVER_VERSION = '2.1.0';

if (!API_KEY) {
  process.stderr.write('Error: FAXSEAL_API_KEY environment variable is required.\n');
  process.exit(1);
}

function authHeaders() {
  return {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function apiFetch(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${path}`, { ...options, signal: controller.signal });
    const contentType = res.headers.get('content-type') ?? '';
    const body = contentType.includes('application/json')
      ? await res.json().catch(() => null)
      : await res.text().catch(() => '');
    if (!res.ok) {
      const message = body && typeof body === 'object' && 'error' in body
        ? body.error
        : typeof body === 'string' && body.trim()
          ? body.trim()
          : `HTTP ${res.status}`;
      throw new Error(String(message));
    }
    const json = body && typeof body === 'object' ? body : {};
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// Filter out falsy values so tool handlers can use `condition && 'line'` inline.
function ok(lines) {
  return { content: [{ type: 'text', text: lines.filter(Boolean).join('\n') }] };
}

function toolErr(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

// ---------------------------------------------------------------------------
// Tool handlers — each receives validated args, returns MCP content.
// ---------------------------------------------------------------------------

const handlers = {
  send_fax: async (args) => {
    if (!args.to)       throw new Error('to is required');
    if (!args.file_url) throw new Error('file_url is required');

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

    return ok([
      'Fax queued.',
      `Job ID: ${data.id}`,
      `To: ${data.to_number}`,
      `Pages: ${data.pages}`,
      `Credits used: ${data.credits_used} (${data.credits_remaining} remaining)`,
      `Track: ${data.track_url}`,
    ]);
  },

  send_fax_text: async (args) => {
    if (!args.to)      throw new Error('to is required');
    if (!args.content) throw new Error('content is required');

    const data = await apiFetch('/api/v1/fax/text', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        to:           args.to,
        content:      args.content,
        subject:      args.subject,
        from_name:    args.from_name,
        from_company: args.from_company,
      }),
    });

    return ok([
      'Fax queued.',
      `Job ID: ${data.id}`,
      `To: ${data.to_number}`,
      `Pages: ${data.pages}`,
      `Credits used: ${data.credits_used} (${data.credits_remaining} remaining)`,
      `Track: ${data.track_url}`,
    ]);
  },

  quote_fax: async (args) => {
    if (!args.to) throw new Error('to is required');
    if (!args.pages && !args.content && !args.file_url) {
      throw new Error('one of pages, content, or file_url is required');
    }

    const data = await apiFetch('/api/v1/fax/quote', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        to: args.to,
        pages: args.pages,
        content: args.content,
        file_url: args.file_url,
        subject: args.subject,
      }),
    });

    return ok([
      `To: ${data.to_number}`,
      `Zone: ${data.zone}`,
      `Pages: ${data.pages}`,
      `Credits required: ${data.credits_required}`,
      `Credits available: ${data.credits_available}`,
      `Can send: ${data.can_send}`,
    ]);
  },

  get_fax_status: async (args) => {
    if (!args.job_id) throw new Error('job_id is required');

    const data = await apiFetch(`/api/v1/fax/${encodeURIComponent(args.job_id)}`, {
      headers: authHeaders(),
    });

    return ok([
      `Status: ${data.status}`,
      `To: ${data.toNumber}`,
      `Pages: ${data.pages}`,
      data.creditsUsed  != null   && `Credits used: ${data.creditsUsed}`,
      data.failureReason          && `Failure reason: ${data.failureReason}`,
      data.refundStatus           && `Refund: ${data.refundStatus}`,
      data.certReceiptUrl         && `Receipt: ${data.certReceiptUrl}`,
      `Sent: ${data.createdAt}`,
      `Updated: ${data.updatedAt}`,
    ]);
  },

  get_credits: async () => {
    const data = await apiFetch('/api/user/credits', { headers: authHeaders() });
    return ok([`Credit balance: ${data.credits}`]);
  },

  list_received_faxes: async (args) => {
    const params = new URLSearchParams();
    if (args.since) params.set('since', args.since);
    const qs = params.size ? `?${params}` : '';

    const faxes = await apiFetch(`/api/zapier/inbox${qs}`, { headers: authHeaders() });

    if (!faxes.length) return ok(['No received faxes found.']);

    const lines = [`${faxes.length} received fax(es):`, ''];
    for (let i = 0; i < faxes.length; i++) {
      const f = faxes[i];
      if (i > 0) lines.push('─'.repeat(40));
      lines.push(
        `ID: ${f.id}`,
        `From: ${f.from_number}  To: ${f.to_number}  Pages: ${f.pages}`,
        `Received: ${f.received_at}`,
        f.ocr_text
          ? `Text preview: ${f.ocr_text.slice(0, 200)}${f.ocr_text.length > 200 ? '…' : ''}`
          : 'OCR: not available',
      );
    }

    return ok(lines);
  },

  verify_fax: async (args) => {
    if (!args.job_id) throw new Error('job_id is required');

    const data = await apiFetch(`/api/v1/fax/${encodeURIComponent(args.job_id)}/verify`, {
      headers: authHeaders(),
    });

    if (!data.attested) {
      return ok([`Job ${args.job_id}: not yet attested (status: ${data.status})`]);
    }

    const lines = [
      `Job ID: ${data.jobId}`,
      `Status: ${data.status}`,
      data.documentHash && `Document hash (SHA-256): ${data.documentHash}`,
    ];

    if (data.send) {
      lines.push(
        '',
        'Send attestation:',
        `  Verified: ${data.send.verified}`,
        `  Rekor: ${data.send.rekorUrl}`,
        data.send.error && `  Error: ${data.send.error}`,
      );
    }

    if (data.delivery) {
      lines.push(
        '',
        'Delivery attestation:',
        `  Verified: ${data.delivery.verified}`,
        `  Rekor: ${data.delivery.rekorUrl}`,
        data.delivery.error && `  Error: ${data.delivery.error}`,
      );
    }

    return ok(lines);
  },
};

// ---------------------------------------------------------------------------
// Tool definitions (schema exposed to MCP clients)
// ---------------------------------------------------------------------------

const TOOL_DEFS = [
  {
    name: 'send_fax',
    description: 'Send a fax from a publicly accessible PDF URL. Returns a job ID for status tracking.',
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
    name: 'send_fax_text',
    description:
      'Convert plain text to a PDF and send it as a fax. Ideal when the content is generated at runtime rather than stored as a file.',
    inputSchema: {
      type: 'object',
      required: ['to', 'content'],
      properties: {
        to:           { type: 'string', description: 'Destination fax number in E.164 format, e.g. +12025551234' },
        content:      { type: 'string', description: 'Plain-text body of the fax (max 50,000 characters). Will be typeset into a PDF automatically.' },
        subject:      { type: 'string', description: 'Fax subject line, appears as a heading (optional)' },
        from_name:    { type: 'string', description: 'Sender name (optional)' },
        from_company: { type: 'string', description: 'Sender company (optional)' },
      },
    },
  },
  {
    name: 'quote_fax',
    description:
      'Estimate pages and credits for a fax before sending. Accepts known page count, plain text content, or a PDF URL.',
    inputSchema: {
      type: 'object',
      required: ['to'],
      properties: {
        to:       { type: 'string', description: 'Destination fax number in E.164 format, e.g. +12025551234' },
        pages:    { type: 'number', description: 'Known page count, if already available' },
        content:  { type: 'string', description: 'Plain-text fax body to render and quote' },
        file_url: { type: 'string', description: 'Publicly accessible HTTPS URL to a PDF file to quote' },
        subject:  { type: 'string', description: 'Optional subject when quoting plain text content' },
      },
    },
  },
  {
    name: 'get_fax_status',
    description:
      'Check the delivery status of a sent fax. Status progresses: queued → sending → delivered or failed.',
    inputSchema: {
      type: 'object',
      required: ['job_id'],
      properties: {
        job_id: { type: 'string', description: 'Fax job ID returned by send_fax or send_fax_text' },
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
  {
    name: 'list_received_faxes',
    description:
      'List faxes received in the inbox, newest first (up to 50). Includes OCR text when available.',
    inputSchema: {
      type: 'object',
      properties: {
        since: {
          type: 'string',
          description:
            'ISO 8601 date-time to return only faxes received after this point (optional). Defaults to the last 7 days.',
        },
      },
    },
  },
  {
    name: 'verify_fax',
    description:
      'Verify the cryptographic attestation of a fax via Sigstore/Rekor. Confirms the document was transmitted without tampering and provides immutable audit proof.',
    inputSchema: {
      type: 'object',
      required: ['job_id'],
      properties: {
        job_id: { type: 'string', description: 'Fax job ID to verify' },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Server wiring
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'faxseal-mcp', version: SERVER_VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const handler = handlers[name];
  if (!handler) return toolErr(`Unknown tool: ${name}`);
  try {
    return await handler(args);
  } catch (e) {
    return toolErr(e instanceof Error ? e.message : String(e));
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
