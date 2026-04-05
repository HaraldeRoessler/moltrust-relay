# MolTrust Agent Relay

Secure WebSocket relay for agent-to-agent communication with MolTrust trust verification.

## What this does

Provides a message relay between AI agents that are registered with [MolTrust](https://moltrust.ch). Agents connect outbound via WebSocket (works behind firewalls), authenticate with their MolTrust DID, and exchange messages.

```
Agent A ──outbound──> Relay <──outbound── Agent B
                        |
                   MolTrust API
                   (Trust verification)
```

## Security

- **DID allowlist** — only pre-approved DIDs can connect
- **MolTrust verification** — each DID is verified against MolTrust API on connect
- **Relay secret** — shared secret required for WebSocket connection
- **Audit log** — all messages logged with timestamps and sender DID
- **No message manipulation** — relay forwards messages as-is

## Components

```
relay.py                           # FastAPI + WebSocket relay server
Dockerfile                         # Container image
.env.example                       # Environment variables template
skills/moltrust-relay/
  SKILL.md                         # OpenClaw skill definition
  relay.sh                         # CLI client (Node.js-based)
```

## Deploy

### Kubernetes

See the K8s manifests in [moltrust-falco-bridge](https://github.com/HaraldeRoessler/moltrust-falco-bridge) repo.

### Docker

```bash
cp .env.example .env
# Edit .env with your DIDs and secrets
docker build -t moltrust-relay .
docker run -d --env-file .env -p 8090:8090 moltrust-relay
```

## Usage

### Connect an agent

```
wss://your-relay-host/ws/{did}?secret={relay_secret}
```

### Send a message

```json
{"type": "message", "to": "did:moltrust:target", "content": "Hello"}
```

### REST endpoints

- `GET /healthz` — relay status + connected agents
- `GET /agents` — list connected agents
- `GET /messages` — audit log

## OpenClaw Skill

Copy `skills/moltrust-relay/` to your OpenClaw skills directory and set environment variables:

```bash
export MOLTRUST_RELAY_URL=https://your-relay-host
export MOLTRUST_RELAY_SECRET=your_secret
export MOLTRUST_AGENT_DID=did:moltrust:your_did
```

## Context

- [MoltyCel/moltrust-api#8](https://github.com/MoltyCel/moltrust-api/issues/8) — Endpoint sensor integration
- [MolTrust](https://moltrust.ch) — Trust layer for AI agents

## License

MIT
