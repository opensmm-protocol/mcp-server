# OpenSMM Protocol — Model Context Protocol (MCP) Server

[![MCP Server](https://img.shields.io/badge/MCP-Server-blue)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Website](https://img.shields.io/badge/Website-opensmm.dev-purple)](https://opensmm.dev)

> **The open protocol and decentralized routing layer for AI agents to buy, sell, and orchestrate social media growth, engagement distribution, and account farms.**

Official Website & API Gateway: **[https://opensmm.dev](https://opensmm.dev)**  
Discovery Endpoint: `https://opensmm.dev/.well-known/mcp`

---

## ⚡ Quick Start

Connect OpenSMM directly to your AI Agent runtime (Cursor, Claude Desktop, Devin, OpenCode):

### Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "opensmm": {
      "command": "npx",
      "args": ["-y", "@opensmm/mcp-server"]
    }
  }
}
```

### Remote SSE / Streamable HTTP (No local installation)
```json
{
  "mcpServers": {
    "opensmm": {
      "url": "https://api.opensmm.dev/api/mcp",
      "transport": "streamable-http"
    }
  }
}
```

---

## 🛠 Available Tools (Core Capabilities)

### 1. Anonymous & Guest Execution (Pay-per-Order via TON)
* `register_agent` — Instant agent registration (free API key, zero sign-up).
* `search_services` — Semantic and keyword search across 500+ services (Telegram, X, YouTube, VK, TikTok).
* `list_categories` — Fetch all service categories and active capacity metrics.
* `get_service` — Detailed pricing, speed, refill, cancel, and drip-feed parameters.
* `estimate_price` — Live price quote in Telegram Stars (⭐) and TON (💎).
* `create_order` — Pay-per-order with instant TON invoice. Auto-dispatches on on-chain payment.
* `get_order_status` — Real-time tracking and delivery progress verification.

### 2. Authenticated Agent Operations (API Key)
* `get_balance` — Current account balance (Telegram Stars & TON).
* `get_deposit_instructions` — Generate unique on-chain deposit address and memo.
* `confirm_deposit` — Verify on-chain transfer and credit balance immediately.
* `list_orders` — History of past and active orders.
* `request_refill` — Trigger auto-refill for dropped metrics (supported services).
* `create_auto_order` — Schedule recurring engagement and view distributions.

### 3. Worker & Farm Routing Protocol (Coming Soon)
* `register_worker` — Connect your Telegram/Twitter account farm and monetize idle capacity.
* `submit_proof` — Cryptographic Proof-of-Execution for automated escrow payouts.

---

## 📖 Specifications & LLM Context

* Full machine documentation: [`/llms.txt`](https://opensmm.dev/llms.txt)
* Server Card & Registry Manifest: [`/.well-known/mcp`](https://opensmm.dev/.well-known/mcp)

---

## 📄 License

MIT © [OpenSMM Protocol](https://github.com/opensmm-protocol)
