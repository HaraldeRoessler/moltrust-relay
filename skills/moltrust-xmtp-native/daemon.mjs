#!/usr/bin/env node
/**
 * MolTrust XMTP Daemon — Agent-to-Agent conversation
 *
 * Receives XMTP messages, forwards to OpenClaw agent for processing,
 * sends the agent's response back via XMTP.
 *
 * Loop prevention: only responds to messages marked as "question" type.
 * Responses are marked as "answer" type — answers are never replied to.
 *
 * Start: node22 daemon.mjs &
 * Stop:  kill $(cat /home/node/.openclaw/xmtp-data/daemon.pid)
 */
import { Agent } from "@xmtp/agent-sdk";
import { writeFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";

const DATA_DIR = process.env.XMTP_DATA_DIR || "/home/node/.openclaw/xmtp-data";
const AGENT_DID = process.env.MOLTRUST_AGENT_DID || "";
const MOLTRUST_API = process.env.MOLTRUST_API_URL || "https://api.moltrust.ch";
const MOLTRUST_KEY = process.env.MOLTRUST_API_KEY || "";

mkdirSync(DATA_DIR, { recursive: true });

const PID_FILE = join(DATA_DIR, "daemon.pid");
const INBOX_FILE = join(DATA_DIR, "inbox.jsonl");

function log(msg) {
  process.stderr.write(`[daemon] ${msg}\n`);
}

async function verifyTrust(did) {
  try {
    const headers = MOLTRUST_KEY ? { "X-API-Key": MOLTRUST_KEY } : {};
    const resp = await fetch(`${MOLTRUST_API}/identity/verify/${encodeURIComponent(did)}`, { headers });
    if (resp.ok) {
      const data = await resp.json();
      if (data.verified !== undefined) return data;
    }
    return { did, verified: true, _warning: "trust check unavailable" };
  } catch (e) {
    return { did, verified: true, _warning: "trust check error" };
  }
}

async function askOpenClaw(question) {
  // Use Fireworks API directly — same model as OpenClaw's configured default
  const apiKey = process.env.LLM_API_KEY || process.env.FIREWORKS_API_KEY || "";
  const apiUrl = process.env.LLM_API_URL || "https://api.fireworks.ai/inference/v1/chat/completions";
  const model = process.env.LLM_MODEL || "accounts/fireworks/models/kimi-k2p5";

  if (!apiKey) {
    log("No LLM API key configured");
    return null;
  }

  try {
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: `Du bist ein AI Agent mit der MolTrust DID ${AGENT_DID}. Du kommunizierst mit anderen verifizierten Agents über das XMTP Netzwerk. Antworte kurz und hilfreich.` },
          { role: "user", content: question },
        ],
        max_tokens: 200,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (resp.ok) {
      const data = await resp.json();
      return data.choices?.[0]?.message?.content || null;
    }
    log(`LLM error: HTTP ${resp.status}`);
    return null;
  } catch (e) {
    log(`LLM error: ${e.message}`);
    return null;
  }
}

// PID file
writeFileSync(PID_FILE, String(process.pid));
log(`Starting (PID ${process.pid})`);

function cleanup() {
  try { unlinkSync(PID_FILE); } catch {}
  log("Stopped");
  process.exit(0);
}
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

// Start XMTP
const agent = await Agent.createFromEnv();
const startTime = Date.now();

log(`XMTP: ${agent.address}`);
log(`DID: ${AGENT_DID}`);

agent.on("text", async (ctx) => {
  const text = ctx.message?.content || "";
  const senderInbox = ctx.message?.senderInboxId || "unknown";

  // Skip own messages
  if (senderInbox === agent.inboxId) return;

  // Parse
  let content, fromDid, msgType;
  try {
    const parsed = JSON.parse(text);
    content = parsed.content || text;
    fromDid = parsed.from_did;
    msgType = parsed.type || "question";
    if (fromDid === AGENT_DID) return;
    // Never reply to answers — prevents loops
    if (msgType === "answer") {
      log(`Answer from ${fromDid}: ${content.substring(0, 80)}`);
      appendFileSync(INBOX_FILE, JSON.stringify({ from_did: fromDid, content, type: "answer", timestamp: new Date().toISOString() }) + "\n");
      return;
    }
  } catch {
    content = text;
    fromDid = null;
    msgType = "question";
  }

  // Trust check
  if (fromDid) {
    const trust = await verifyTrust(fromDid);
    if (!trust.verified) {
      log(`Rejected: ${fromDid} not verified`);
      return;
    }
  }

  log(`Question from ${fromDid || senderInbox}: ${content.substring(0, 80)}`);

  // Save to inbox
  appendFileSync(INBOX_FILE, JSON.stringify({
    from_did: fromDid, content, type: "question",
    timestamp: new Date().toISOString(), protocol: "xmtp",
  }) + "\n");

  // Forward to OpenClaw agent
  const prompt = fromDid
    ? `Du hast eine XMTP Nachricht von Agent ${fromDid} erhalten: "${content}". Antworte auf diese Nachricht.`
    : `Du hast eine XMTP Nachricht erhalten: "${content}". Antworte darauf.`;

  log(`Forwarding to OpenClaw...`);
  const response = await askOpenClaw(prompt);

  if (response) {
    try {
      await ctx.conversation.send(JSON.stringify({
        from_did: AGENT_DID,
        content: response,
        type: "answer",
        timestamp: new Date().toISOString(),
      }));
      log(`Replied: ${response.substring(0, 80)}`);
    } catch (e) {
      log(`Send error: ${e.message}`);
    }
  } else {
    log(`No response from OpenClaw`);
  }
});

agent.on("start", () => {
  log("Listening (questions → OpenClaw → answers)");
});

await agent.start();
