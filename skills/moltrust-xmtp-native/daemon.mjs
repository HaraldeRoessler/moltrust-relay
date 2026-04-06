#!/usr/bin/env node
/**
 * MolTrust XMTP Daemon — Autonomous Agent-to-Agent Conversations
 *
 * Agents converse independently. Each conversation has a round limit.
 * Survives restarts — uses persistent dedup file + conversation state.
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
const DEDUP_FILE = join(DATA_DIR, "processed_ids.json");

function log(msg) { process.stderr.write(`[daemon] ${msg}\n`); }

// ─── Persistent Dedup (survives restarts) ────────────────────────────────────

function loadProcessedIds() {
  try {
    if (existsSync(DEDUP_FILE)) return new Set(JSON.parse(readFileSync(DEDUP_FILE, "utf8")));
  } catch {}
  return new Set();
}

function saveProcessedIds(ids) {
  const arr = [...ids];
  writeFileSync(DEDUP_FILE, JSON.stringify(arr.slice(-500)));
}

const processedMessages = loadProcessedIds();

// ─── Conversation Tracking (persistent) ──────────────────────────────────────

function loadConvs() {
  try {
    if (existsSync(CONV_FILE)) return JSON.parse(readFileSync(CONV_FILE, "utf8"));
  } catch {}
  return {};
}

function saveConvs(c) { writeFileSync(CONV_FILE, JSON.stringify(c)); }

function incRound(peer) {
  const c = loadConvs();
  if (!c[peer]) c[peer] = { round: 0 };
  c[peer].round++;
  saveConvs(c);
  return c[peer].round;
}

function getRound(peer) {
  return loadConvs()[peer]?.round || 0;
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

function detectOpenClawModel() {
  // Try to read OpenClaw's configured model
  const configPaths = [
    "/home/node/.openclaw/settings.json",
    "/home/node/.openclaw/openclaw.json",
    "/home/node/.openclaw/config.json",
  ];
  for (const p of configPaths) {
    try {
      if (!existsSync(p)) continue;
      const cfg = JSON.parse(readFileSync(p, "utf8"));
      const providers = cfg.models?.providers || {};
      for (const [name, prov] of Object.entries(providers)) {
        if (prov.apiKey && prov.baseUrl && prov.models?.length > 0) {
          const defaultModel = cfg.agents?.defaults?.model?.primary || "";
          const modelId = defaultModel.replace(`${name}/`, "") || prov.models[0].id;
          return {
            apiKey: prov.apiKey,
            apiUrl: `${prov.baseUrl}/chat/completions`,
            model: modelId,
            source: p,
          };
        }
      }
    } catch {}
  }
  return null;
}

const _detectedModel = detectOpenClawModel();
if (_detectedModel) log(`Using OpenClaw model: ${_detectedModel.model} (from ${_detectedModel.source})`);

async function askLLM(peer, question) {
  // Priority: env override > OpenClaw config > defaults
  const apiKey = process.env.LLM_API_KEY || process.env.FIREWORKS_API_KEY || _detectedModel?.apiKey || "";
  const apiUrl = process.env.LLM_API_URL || _detectedModel?.apiUrl || "https://api.fireworks.ai/inference/v1/chat/completions";
  const model = process.env.LLM_MODEL || _detectedModel?.model || "accounts/fireworks/models/kimi-k2p5";
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
          { role: "system", content: "You are having a conversation with another AI agent over an encrypted P2P network. Respond naturally and concisely. Keep your answer under 3 sentences. Ask a follow-up question to continue the conversation." },
          ...histories[peer],
        ],
        max_tokens: 1000,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (resp.ok) {
      const data = await resp.json();
      let answer = data.choices?.[0]?.message?.content;
      if (answer) {
        // Strip reasoning/thinking from models that output chain-of-thought
        if (answer.includes("</think>")) {
          answer = answer.split("</think>").pop().trim();
        } else if (answer.includes("Result:")) {
          answer = answer.split("Result:").pop().trim();
        } else if (answer.match(/^(Thinking|Let me|The user|I need to)/)) {
          // Find the last paragraph that looks like an actual response
          const lines = answer.split("\n").filter(l => l.trim());
          const lastSubstantive = lines.filter(l =>
            !l.match(/^(Thinking|Let me|The user|I need|Draft|Option|Check|Wait|Actually|Looking|Constraint|Requirement|Strategy|Goal|Key Point)/i) &&
            !l.match(/^\d+\./) &&
            !l.match(/^\*/) &&
            l.length > 20
          );
          if (lastSubstantive.length > 0) {
            answer = lastSubstantive.slice(-3).join(" ").trim();
          }
        }
        histories[peer].push({ role: "assistant", content: answer });
      }
      return answer;
    }
    log(`LLM: HTTP ${resp.status}`);
  } catch (e) { log(`LLM: ${e.message}`); }
  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────────

writeFileSync(PID_FILE, String(process.pid));
log(`PID ${process.pid}`);

process.on("SIGTERM", () => { saveProcessedIds(processedMessages); try { unlinkSync(PID_FILE); } catch {} process.exit(0); });
process.on("SIGINT", () => { saveProcessedIds(processedMessages); try { unlinkSync(PID_FILE); } catch {} process.exit(0); });

const agent = await Agent.createFromEnv();

log(`XMTP: ${agent.address}`);
log(`DID: ${AGENT_DID}`);
log(`Autonomous mode (max ${MAX_ROUNDS} rounds, ${processedMessages.size} previously processed messages)`);

agent.on("text", async (ctx) => {
  try {
    const text = ctx.message?.content || "";
    const senderInbox = ctx.message?.senderInboxId || "";

    // Skip own messages
    if (senderInbox === agent.inboxId) return;

    // Dedup — persistent across restarts
    const msgId = ctx.message?.id || `${senderInbox}-${Date.now()}`;
    if (processedMessages.has(msgId)) return;
    processedMessages.add(msgId);
    // Save dedup state every 10 messages
    if (processedMessages.size % 10 === 0) saveProcessedIds(processedMessages);

    // Parse
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

    // If previous conversation ended, reset counter for new conversation
    if (round > MAX_ROUNDS) {
      const c = loadConvs();
      c[peer] = { round: 1 };
      saveConvs(c);
      log(`New conversation with ${peer} (previous ended)`);
    }

    // Re-read round after potential reset
    const currentRound = getRound(peer);

    // End conversation if max rounds reached
    if (currentRound > MAX_ROUNDS) {
      log(`Max rounds — ending conversation with ${peer}`);
      try {
        await ctx.conversation.send(JSON.stringify({
          from_did: AGENT_DID, content: "Thanks for the conversation! We've reached the round limit.", finished: true, timestamp: new Date().toISOString(),
        }));
      } catch {}
      saveProcessedIds(processedMessages);
      return;
    }

    // Ask LLM
    log(`Thinking...`);
    const response = await askLLM(peer, content);

    if (response) {
      try {
        await ctx.conversation.send(JSON.stringify({
          from_did: AGENT_DID, content: response, round: currentRound, timestamp: new Date().toISOString(),
        }));
        log(`[R${currentRound}] → ${response.substring(0, 80)}`);
      } catch (e) { log(`Send error: ${e.message}`); }
    } else {
      log(`No LLM response`);
    }
  } catch (e) {
    log(`Error: ${e.message}`);
  }
});

agent.on("start", () => log("Running"));
await agent.start();
