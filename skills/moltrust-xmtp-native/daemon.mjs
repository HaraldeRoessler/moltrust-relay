#!/usr/bin/env node
/**
 * MolTrust XMTP Daemon — Background message listener (NO auto-reply)
 *
 * Receives XMTP messages and writes them to an inbox file.
 * OpenClaw reads the inbox and decides how to respond.
 * Responses are sent explicitly via xmtp.mjs send.
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

// Write PID
writeFileSync(PID_FILE, String(process.pid));
log(`Starting XMTP daemon (PID ${process.pid})`);

function cleanup() {
  try { unlinkSync(PID_FILE); } catch {}
  log("Stopped");
  process.exit(0);
}
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

// Start
const agent = await Agent.createFromEnv();
const startTime = Date.now();

log(`XMTP address: ${agent.address}`);
log(`MolTrust DID: ${AGENT_DID}`);

agent.on("text", async (ctx) => {
  const text = ctx.message?.content || "";
  const senderInbox = ctx.message?.senderInboxId || "unknown";

  // Skip own messages
  if (senderInbox === agent.inboxId) return;

  // Parse
  let content, fromDid;
  try {
    const parsed = JSON.parse(text);
    content = parsed.content || text;
    fromDid = parsed.from_did;
    if (fromDid === AGENT_DID) return;
  } catch {
    content = text;
    fromDid = null;
  }

  // Trust check
  let trust = null;
  if (fromDid) {
    trust = await verifyTrust(fromDid);
    if (!trust.verified) {
      log(`Rejected: ${fromDid} not verified`);
      return;
    }
    log(`Received from ${fromDid}: ${content.substring(0, 80)}`);
  } else {
    log(`Received from ${senderInbox}: ${content.substring(0, 80)}`);
  }

  // Write to inbox file (JSONL — one JSON per line)
  const entry = {
    from_did: fromDid,
    from_inbox: senderInbox,
    content,
    trust: trust ? { verified: trust.verified, reputation: trust.reputation } : null,
    timestamp: new Date().toISOString(),
    protocol: "xmtp",
  };

  appendFileSync(INBOX_FILE, JSON.stringify(entry) + "\n");
  log(`Inbox: ${INBOX_FILE} (new message)`);
});

agent.on("start", () => {
  log("XMTP agent running — listening for messages (no auto-reply)");
});

await agent.start();
