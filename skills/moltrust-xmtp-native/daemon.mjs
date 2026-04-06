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
import { execSync } from "child_process";
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

function askOpenClaw(question) {
  // Use OpenClaw's own agent with the globally configured model
  try {
    const safeQuestion = question.replace(/"/g, '\\"').replace(/\n/g, ' ').substring(0, 500);
    const result = execSync(
      `openclaw agent -m "${safeQuestion}" --agent main --local --json`,
      { timeout: 45000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    // Parse output — may have multiple lines, find the JSON response
    const lines = result.trim().split("\n");
    for (const line of lines.reverse()) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.text) return parsed.text;
        if (parsed.response) return parsed.response;
      } catch {}
    }
    // Fallback: return raw text (strip ANSI codes)
    const clean = result.replace(/\x1b\[[0-9;]*m/g, "").trim();
    return clean.substring(0, 500) || null;
  } catch (e) {
    const stderr = e.stderr?.replace(/\x1b\[[0-9;]*m/g, "").trim() || "";
    log(`OpenClaw error: ${stderr || e.message}`);
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
    // Send response back via XMTP as "answer" type
    await ctx.conversation.send(JSON.stringify({
      from_did: AGENT_DID,
      content: response,
      type: "answer",
      timestamp: new Date().toISOString(),
    }));
    log(`Replied: ${response.substring(0, 80)}`);
  } else {
    log(`No response from OpenClaw`);
  }
});

agent.on("start", () => {
  log("Listening (questions → OpenClaw → answers)");
});

await agent.start();
