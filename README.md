# FaxSeal MCP Server

Send, receive, and verify faxes from AI assistants and agents via the [Model Context Protocol](https://modelcontextprotocol.io).

## Tools

| Tool | Description |
|---|---|
| `send_fax` | Send a fax from a publicly accessible PDF URL |
| `send_fax_text` | Type content directly — FaxSeal converts it to a PDF and sends |
| `quote_fax` | Estimate pages and credits before sending |
| `get_fax_status` | Check delivery status of a sent fax |
| `get_credits` | Check your FaxSeal credit balance |
| `list_received_faxes` | List faxes in your inbox with OCR text |
| `verify_fax` | Verify cryptographic delivery attestation via Sigstore/Rekor |

## Setup

**1.** Get an API key at [faxseal.com/dashboard/api-tokens](https://faxseal.com/dashboard/api-tokens)

**2.** Add to Claude Code:
```bash
claude mcp add faxseal -e FAXSEAL_API_KEY=fsx_your_token -- npx faxseal-mcp
```

**3.** Add to Claude Desktop (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "faxseal": {
      "command": "npx",
      "args": ["faxseal-mcp"],
      "env": {
        "FAXSEAL_API_KEY": "fsx_your_token"
      }
    }
  }
}
```

## Usage examples

> "Send the referral letter at https://example.com/referral.pdf to +12025551234"

> "Check the status of fax job abc123"

> "List my received faxes from the last 24 hours"

> "Send a fax to +12025551234 with the following text: Dear Dr. Smith, please find attached..."

## Pricing

Faxes are billed to your FaxSeal credit balance. Credits start from $0.83/fax. [View pricing](https://faxseal.com/pricing).

## Links

- [FaxSeal](https://faxseal.com)
- [API Docs](https://faxseal.com/docs/api)
- [npm package](https://www.npmjs.com/package/faxseal-mcp)
