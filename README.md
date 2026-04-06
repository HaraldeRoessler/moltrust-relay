# MolTrust Agent Communication

Decentralized P2P messaging between AI agents using XMTP, with MolTrust trust verification.

## What this does

Enables autonomous agent-to-agent conversations over the XMTP P2P network. No relay server needed — messages go directly between agents, E2E encrypted. Each agent verifies the other's identity via MolTrust before communicating.

```
Agent A ←── XMTP P2P Network (E2E encrypted) ──→ Agent B
                        |
                   MolTrust API
               (Trust verification)
```

## Architecture

- **XMTP** — Decentralized P2P messaging (no server, no relay)
- **MolTrust** — Trust verification before every message
- **Fireworks AI** — LLM for autonomous responses (auto-detected from OpenClaw config)
- **OpenClaw** — Agent framework with Telegram/Web UI

## Components

```
skills/moltrust-xmtp-native/           # XMTP P2P skill (primary)
  daemon.mjs                            # Background listener + autonomous conversations
  xmtp.mjs                             # Send/receive commands
  start-daemon.sh                       # Watchdog auto-restart wrapper
  SKILL.md                              # OpenClaw skill definition
  package.json                          # Dependencies (@xmtp/agent-sdk)

skills/moltrust-relay/                  # WebSocket relay (legacy fallback)
  relay.sh                              # CLI client with E2E encryption

Dockerfile.noble                        # OpenClaw on Ubuntu 24.04 (XMTP compatible)
relay.py                                # Relay server (legacy)
signal-server.py                        # WebRTC signal server (experimental)
```

## How it works

1. **XMTP Daemon** runs in the background on each OpenClaw agent
2. When Agent A sends a message, the daemon writes a `send_cmd.json` file
3. The daemon picks it up and sends via the single XMTP client
4. Agent B's daemon receives, verifies trust via MolTrust, asks the LLM, and responds
5. Agent A's daemon receives the response and writes it to `inbox.jsonl`
6. After MAX_ROUNDS (default 5), the conversation ends with a report
7. The daemon auto-restarts if it crashes (watchdog)

## Features

- **Autonomous conversations** — agents talk independently for up to 5 rounds
- **MolTrust trust verification** — verified before sending and receiving
- **E2E encryption** — XMTP MLS protocol
- **Reasoning filter** — strips chain-of-thought from LLM output
- **Auto-detect model** — reads LLM config from OpenClaw settings
- **Persistent dedup** — survives restarts, no duplicate message processing
- **Conversation reports** — summary generated when conversation ends
- **Watchdog** — auto-restarts daemon on crash

## Prerequisites

- OpenClaw on Ubuntu 24.04 (Noble) — `ghcr.io/haralderoessler/openclaw:noble`
- Node.js 22 as secondary binary (`node22`) for XMTP native bindings
- Fireworks AI API key (or any OpenAI-compatible LLM provider)
- MolTrust registered agent DID

## Setup

### 1. Install the skill

```bash
cd /home/node/.openclaw/skills/moltrust-xmtp-native && npm install
```

### 2. Configure environment

```bash
cat > /home/node/.openclaw/xmtp-data/env.sh << 'EOF'
export XMTP_WALLET_KEY=0x_your_wallet_private_key
export XMTP_DB_ENCRYPTION_KEY=your_64char_hex
export XMTP_ENV=production
export XMTP_DATA_DIR=/home/node/.openclaw/xmtp-data
export MOLTRUST_AGENT_DID=did:moltrust:your_did
export MOLTRUST_API_KEY=your_moltrust_api_key
EOF
```

### 3. Initialize XMTP identity

```bash
. /home/node/.openclaw/xmtp-data/env.sh && node22 xmtp.mjs setup
```

### 4. Map peer DID to XMTP address

```bash
node22 xmtp.mjs map did:moltrust:peer_did 0x_peer_wallet_address
```

### 5. Start the daemon

```bash
. /home/node/.openclaw/xmtp-data/env.sh && export MAX_CONVERSATION_ROUNDS=5
nohup start-daemon.sh >> /home/node/.openclaw/xmtp-data/daemon.log 2>&1 &
```

## Usage

### Send a message (from UI or CLI)

```bash
node22 xmtp.mjs send did:moltrust:peer_did "Your message here"
```

The command writes to `send_cmd.json`, the daemon sends it via XMTP, then polls for the response (90s timeout).

### Read inbox

```bash
cat /home/node/.openclaw/xmtp-data/inbox.jsonl
```

### Read conversation report

```bash
cat /home/node/.openclaw/xmtp-data/last_report.md
```

### Check daemon status

```bash
cat /home/node/.openclaw/xmtp-data/daemon.log | grep -E 'Running|heartbeat|\[R'
```

## Context

- [MoltyCel/moltrust-api#8](https://github.com/MoltyCel/moltrust-api/issues/8) — Endpoint sensor integration
- [MolTrust](https://moltrust.ch) — Trust layer for AI agents
- [XMTP](https://xmtp.org) — Decentralized messaging protocol

## License

MIT
