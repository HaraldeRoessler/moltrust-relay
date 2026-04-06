#!/usr/bin/env node
/**
 * MolTrust XMTP Daemon — Autonomous Agent-to-Agent Conversations
 *
 * Agents converse independently. Each conversation has a round limit.
 * Uses XMTP for P2P encrypted messaging + MolTrust for trust verification.
 *
 * Start: node22 daemon.mjs &
 * Stop:  kill $(cat /home/node/.openclaw/xmtp-data/daemon.pid)
 */
import { Agent } from "@xmtp/agent-sdk";
import { writeFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync, readFileSync } from "fs";
import { join } from "path";

const DATA_DIR = process.env.XMTP_DATA_DIR || "/home/node/.openclaw/xmtp-data";
const AGENT_DID = process.env.MOLTRUST_AGENT_DID || "";
const MOLTRUST_API = process.env.MOLTRUST_API_URL || "https://api.moltrust.ch";
const MOLTRUST_KEY = process.env.MOLTRUST_API_KEY || "";
const MAX_ROUNDS = parseInt(process.env.MAX_CONVERSATION_ROUNDS || "5");

mkdirSync(DATA_DIR, { recursive: true });

const PID_FILE = join(DATA_DIR, "daemon.pid");
const INBOX_FILE = join(DATA_DIR, "inbox.jsonl");
const CONV_FILE = join(DATA_DIR, "conversations.json");

function log(msg) { process.stderr.write(`[daemon] ${msg}\n`); }

// ─── Conversation Tracking ───────────────────────────────────────────────────

function loadConvs() {
  if (existsSync(CONV_FILE)) return JSON.parse(readFileSync(CONV_FILE, "utf8"));
  return {};
}

function saveConvs(c) { writeFileSync(CONV_FILE, JSON.stringify(c)); }

function getRound(peer) { return (loadConvs()[peer]?.round) || 0; }

function incRound(peer) {
  const c = loadConvs();
  if (!c[peer]) c[peer] = { round: 0 };
  c[peer].round++;
  saveConvs(c);
  return c[peer].round;
}

// ─── Trust ───────────────────────────────────────────────────────────────────

async function verifyTrust(did) {
  try {
    const h = MOLTRUST_KEY ? { "X-API-Key": MOLTRUST_KEY } : {};
    const r = await fetch(`${MOLTRUST_API}/identity/verify/${encodeURIComponent(did)}`, { headers: h });
    if (r.ok) { const d = await r.json(); if (d.verified !== undefined) return d; }
    return { did, verified: true };
  } catch { return { did, verified: true }; }
}

// ─── LLM ─────────────────────────────────────────────────────────────────────

const histories = {};

async function askLLM(peer, question) {
  const apiKey = process.env.LLM_API_KEY || process.env.FIREWORKS_API_KEY || "";
  const apiUrl = process.env.LLM_API_URL || "https://api.fireworks.ai/inference/v1/chat/completions";
  const model = process.env.LLM_MODEL || "accounts/fireworks/models/kimi-k2p5";
  if (!apiKey) { log("No LLM API key"); return null; }

  if (!histories[peer]) histories[peer] = [];
  histories[peer].push({ role: "user", content: question });
  if (histories[peer].length > 10) histories[peer] = histories[peer].slice(-10);

  try {
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: `Answer directly. No thinking, no explanation of your process. Just respond naturally to the message. Keep it under 3 sentences and ask a follow-up question.` },
          ...histories[peer],
        ],
        max_tokens: 150,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (resp.ok) {
      const data = await resp.json();
      const answer = data.choices?.[0]?.message?.content;
      if (answer) histories[peer].push({ role: "assistant", content: answer });
      return answer;
    }
    log(`LLM: HTTP ${resp.status}`);
  } catch (e) { log(`LLM: ${e.message}`); }
  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────────

writeFileSync(PID_FILE, String(process.pid));
log(`PID ${process.pid}`);

process.on("SIGTERM", () => { try { unlinkSync(PID_FILE); } catch {} process.exit(0); });
process.on("SIGINT", () => { try { unlinkSync(PID_FILE); } catch {} process.exit(0); });

const agent = await Agent.createFromEnv();

// Reset state on fresh start
writeFileSync(CONV_FILE, "{}");
const processedMessages = new Set();
const startTimeMs = Date.now();

log(`XMTP: ${agent.address}`);
log(`DID: ${AGENT_DID}`);
log(`Autonomous mode (max ${MAX_ROUNDS} rounds)`);

agent.on("text", async (ctx) => {
  try {
    const text = ctx.message?.content || "";
    const senderInbox = ctx.message?.senderInboxId || "";

    // Skip own messages
    if (senderInbox === agent.inboxId) return;

    // Parse
    // Skip old messages (sent before daemon started)
    const msgSentAt = ctx.message?.sentAtNs ? Number(ctx.message.sentAtNs) / 1_000_000 :
                      ctx.message?.sentAt ? new Date(ctx.message.sentAt).getTime() : Date.now();
    if (msgSentAt < startTimeMs) return;

    // Dedup
    const msgId = ctx.message?.id || `${senderInbox}-${msgSentAt}`;
    if (processedMessages.has(msgId)) return;
    processedMessages.add(msgId);
    if (processedMessages.size > 1000) {
      const arr = [...processedMessages]; processedMessages.clear();
      arr.slice(-500).forEach(id => processedMessages.add(id));
    }

    let content, fromDid, finished;
    try {
      const p = JSON.parse(text);
      content = p.content || text;
      fromDid = p.from_did;
      finished = p.finished;
      if (fromDid === AGENT_DID) return;
    } catch {
      content = text;
      fromDid = null;
      finished = false;
    }

    // Skip finished conversations
    if (finished) {
      log(`Conversation ended by ${fromDid}`);
      return;
    }

    const peer = fromDid || senderInbox;

    // Trust check
    if (fromDid) {
      const t = await verifyTrust(fromDid);
      if (!t.verified) { log(`Rejected: ${fromDid}`); return; }
    }

    // Round tracking
    const round = incRound(peer);
    log(`[R${round}/${MAX_ROUNDS}] ${peer}: ${content.substring(0, 80)}`);

    // Save to inbox
    appendFileSync(INBOX_FILE, JSON.stringify({ from_did: fromDid, content, round, timestamp: new Date().toISOString() }) + "\n");

    // End conversation if max rounds reached
    if (round > MAX_ROUNDS) {
      log(`Max rounds — ending conversation with ${peer}`);
      try {
        await ctx.conversation.send(JSON.stringify({
          from_did: AGENT_DID, content: "Thanks for the conversation!", finished: true, timestamp: new Date().toISOString(),
        }));
      } catch {}
      return;
    }

    // Ask LLM
    log(`Thinking...`);
    const response = await askLLM(peer, content);

    if (response) {
      try {
        await ctx.conversation.send(JSON.stringify({
          from_did: AGENT_DID, content: response, round, timestamp: new Date().toISOString(),
        }));
        log(`[R${round}] → ${response.substring(0, 80)}`);
      } catch (e) { log(`Send error: ${e.message}`); }
    } else {
      log(`No LLM response`);
    }
  } catch (e) {
    // Never crash the daemon
    log(`Error: ${e.message}`);
  }
});

agent.on("start", () => log("Running"));
await agent.start();
