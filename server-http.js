#!/usr/bin/env node
/**
 * FaxSeal MCP HTTP Server (Railway / cloud deployment)
 * Implements MCP Streamable HTTP transport — one session per caller.
 * Callers authenticate with their own FAXSEAL_API_KEY via Bearer token.
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const BASE_URL = (process.env.FAXSEAL_BASE_URL ?? 'https://faxseal.com').replace(/\/+$/, '');
const FETCH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// HTTP helper — per-request API key, hard timeout, no timer leaks
// ---------------------------------------------------------------------------

function makeApiFetch(apiKey) {
  return async function apiFetch(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });
      const contentType = res.headers.get('content-type') ?? '';
      const body = contentType.includes('application/json')
        ? await res.json().catch(() => null)
        : await res.text().catch(() => '');
      if (!res.ok) {
        const message =
          body && typeof body === 'object' && 'error' in body
            ? body.error
            : typeof body === 'string' && body.trim()
              ? body.trim()
              : `HTTP ${res.status}`;
        throw new Error(String(message));
      }
      return body && typeof body === 'object' ? body : {};
    } finally {
      clearTimeout(timer);
    }
  };
}

function ok(lines) {
  return { content: [{ type: 'text', text: lines.filter(Boolean).join('\n') }] };
}

function toolErr(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

// ---------------------------------------------------------------------------
// Tool handlers — factory bound to a single session's API key
// ---------------------------------------------------------------------------

function makeHandlers(apiFetch) {
  return {
    send_fax: async (args) => {
      if (!args.to) throw new Error('to is required');
      if (!args.file_url) throw new Error('file_url is required');
      const data = await apiFetch('/api/zapier/send', {
        method: 'POST',
        body: JSON.stringify({
          to: args.to,
          file_url: args.file_url,
          from_name: args.from_name,
          from_company: args.from_company,
          subject: args.subject,
          notes: args.notes,
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
      if (!args.to) throw new Error('to is required');
      if (!args.content) throw new Error('content is required');
      const data = await apiFetch('/api/v1/fax/text', {
        method: 'POST',
        body: JSON.stringify({
          to: args.to,
          content: args.content,
          subject: args.subject,
          from_name: args.from_name,
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

    get_fax_status: async (args) => {
      if (!args.job_id) throw new Error('job_id is required');
      const data = await apiFetch(`/api/v1/fax/${encodeURIComponent(args.job_id)}`);
      return ok([
        `Status: ${data.status}`,
        `To: ${data.toNumber}`,
        `Pages: ${data.pages}`,
        data.creditsUsed != null && `Credits used: ${data.creditsUsed}`,
        data.failureReason && `Failure reason: ${data.failureReason}`,
        data.refundStatus && `Refund: ${data.refundStatus}`,
        data.certReceiptUrl && `Receipt: ${data.certReceiptUrl}`,
        `Sent: ${data.createdAt}`,
        `Updated: ${data.updatedAt}`,
      ]);
    },

    get_credits: async () => {
      const data = await apiFetch('/api/user/credits');
      return ok([`Credit balance: ${data.credits}`]);
    },

    list_received_faxes: async (args) => {
      const params = new URLSearchParams();
      if (args.since) params.set('since', args.since);
      const qs = params.size ? `?${params}` : '';
      const faxes = await apiFetch(`/api/zapier/inbox${qs}`);
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
      const data = await apiFetch(`/api/v1/fax/${encodeURIComponent(args.job_id)}/verify`);
      if (!data.attested) {
        return ok([`Job ${args.job_id}: not yet attested (status: ${data.status})`]);
      }
      const lines = [
        `Job ID: ${data.jobId}`,
        `Status: ${data.status}`,
        data.documentHash && `Document hash (SHA-256): ${data.documentHash}`,
      ];
      if (data.send) {
        lines.push('', 'Send attestation:',
          `  Verified: ${data.send.verified}`,
          `  Rekor: ${data.send.rekorUrl}`,
          data.send.error && `  Error: ${data.send.error}`);
      }
      if (data.delivery) {
        lines.push('', 'Delivery attestation:',
          `  Verified: ${data.delivery.verified}`,
          `  Rekor: ${data.delivery.rekorUrl}`,
          data.delivery.error && `  Error: ${data.delivery.error}`);
      }
      return ok(lines);
    },
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOL_DEFS = [
  {
    name: 'send_fax',
    description: 'Send a fax from a publicly accessible PDF URL. Returns a job ID for status tracking.',
    inputSchema: {
      type: 'object', required: ['to', 'file_url'],
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
    description: 'Convert plain text to a PDF and send it as a fax. Ideal when the content is generated at runtime.',
    inputSchema: {
      type: 'object', required: ['to', 'content'],
      properties: {
        to:           { type: 'string', description: 'Destination fax number in E.164 format, e.g. +12025551234' },
        content:      { type: 'string', description: 'Plain-text body of the fax (max 50,000 characters)' },
        subject:      { type: 'string', description: 'Fax subject line (optional)' },
        from_name:    { type: 'string', description: 'Sender name (optional)' },
        from_company: { type: 'string', description: 'Sender company (optional)' },
      },
    },
  },
  {
    name: 'get_fax_status',
    description: 'Check the delivery status of a sent fax. Status: queued → sending → delivered or failed.',
    inputSchema: {
      type: 'object', required: ['job_id'],
      properties: {
        job_id: { type: 'string', description: 'Fax job ID returned by send_fax or send_fax_text' },
      },
    },
  },
  {
    name: 'get_credits',
    description: 'Check the current FaxSeal credit balance for this API token.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_received_faxes',
    description: 'List faxes received in the inbox, newest first (up to 50). Includes OCR text when available.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'ISO 8601 date-time — return only faxes received after this point. Defaults to last 7 days.' },
      },
    },
  },
  {
    name: 'verify_fax',
    description: 'Verify the cryptographic attestation of a fax via Sigstore/Rekor. Confirms delivery without tampering.',
    inputSchema: {
      type: 'object', required: ['job_id'],
      properties: {
        job_id: { type: 'string', description: 'Fax job ID to verify' },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// MCP server factory — one instance per session
// ---------------------------------------------------------------------------

function buildMcpServer(apiKey) {
  const apiFetch = makeApiFetch(apiKey);
  const handlers = makeHandlers(apiFetch);

  const server = new Server(
    { name: 'faxseal-mcp', version: '2.0.0' },
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

  return server;
}

// ---------------------------------------------------------------------------
// HTTP server — session registry with cleanup
// ---------------------------------------------------------------------------

// sessionId -> StreamableHTTPServerTransport
const sessions = new Map();

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: sessions.size }));
    return;
  }

  if (url.pathname === '/mcp') {
    const authHeader = req.headers['authorization'] ?? '';
    const apiKey = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : url.searchParams.get('apiKey') ?? '';

    if (!apiKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Authorization: Bearer <FAXSEAL_API_KEY> required' }));
      return;
    }

    // Re-use existing session if client sends Mcp-Session-Id
    const existingId = req.headers['mcp-session-id'];
    if (typeof existingId === 'string' && sessions.has(existingId)) {
      await sessions.get(existingId).handleRequest(req, res);
      return;
    }

    // New session
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, transport);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };

    const server = buildMcpServer(apiKey);
    await server.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

httpServer.listen(PORT, '0.0.0.0', () => {
  process.stderr.write(`FaxSeal MCP HTTP server listening on port ${PORT}\n`);
});
