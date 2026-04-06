#!/usr/bin/env node
/**
 * MolTrust XMTP Skill — Decentralized P2P Agent Messaging
 *
 * Uses @xmtp/agent-sdk for simple agent messaging.
 * Wallet = DID = Messaging = Payment identity.
 * MolTrust trust verification before every message.
 *
 * Must run with node22 (not node24) due to native binding compatibility.
 */
import { Agent } from "@xmtp/agent-sdk";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = process.env.XMTP_DATA_DIR || "/home/node/.openclaw/xmtp-data";
const AGENT_DID = process.env.MOLTRUST_AGENT_DID || "";
const MOLTRUST_API = process.env.MOLTRUST_API_URL || "https://api.moltrust.ch";
const MOLTRUST_KEY = process.env.MOLTRUST_API_KEY || "";

mkdirSync(DATA_DIR, { recursive: true });

// ─── DID ↔ Address Map ──────────────────────────────────────────────────────

const MAP_FILE = join(DATA_DIR, "did-address-map.json");

function loadMap() {
  if (existsSync(MAP_FILE)) return JSON.parse(readFileSync(MAP_FILE, "utf8"));
  return {};
}

function saveMap(map) {
  writeFileSync(MAP_FILE, JSON.stringify(map, null, 2));
}

// ─── MolTrust Trust Check ────────────────────────────────────────────────────

async function verifyTrust(did) {
  try {
    const headers = MOLTRUST_KEY ? { "X-API-Key": MOLTRUST_KEY } : {};
    const resp = await fetch(`${MOLTRUST_API}/identity/verify/${encodeURIComponent(did)}`, { headers });
    if (resp.ok) return await resp.json();
  } catch (e) { /* ignore */ }
  return { did, verified: false };
}

// ─── Commands ────────────────────────────────────────────────────────────────

const command = process.argv[2];

switch (command) {
  case "setup": {
    const agent = await Agent.createFromEnv();
    const map = loadMap();
    map[AGENT_DID] = agent.address;
    saveMap(map);
    console.log(JSON.stringify({
      status: "ready",
      address: agent.address,
      did: AGENT_DID,
      env: process.env.XMTP_ENV || "production",
    }));
    break;
  }

  case "address": {
    const agent = await Agent.createFromEnv();
    console.log(JSON.stringify({ did: AGENT_DID, address: agent.address }));
    break;
  }

  case "map": {
    const did = process.argv[3];
    const addr = process.argv[4];
    if (!did || !addr) {
      console.log(JSON.stringify({ error: "Usage: xmtp.mjs map <did> <address>" }));
      process.exit(1);
    }
    const map = loadMap();
    map[did] = addr;
    saveMap(map);
    console.log(JSON.stringify({ status: "mapped", did, address: addr }));
    break;
  }

  case "send": {
    const targetDid = process.argv[3];
    const message = process.argv.slice(4).join(" ");
    if (!targetDid || !message) {
      console.log(JSON.stringify({ error: "Usage: xmtp.mjs send <did> <message>" }));
      process.exit(1);
    }

    const trust = await verifyTrust(targetDid);
    if (!trust.verified) {
      console.log(JSON.stringify({ error: `Agent ${targetDid} not verified`, trust }));
      process.exit(1);
    }

    const map = loadMap();
    const targetAddress = map[targetDid];
    if (!targetAddress) {
      console.log(JSON.stringify({ error: `No XMTP address for ${targetDid}. Run: xmtp.mjs map ${targetDid} <address>` }));
      process.exit(1);
    }

    const agent = await Agent.createFromEnv();

    const conversation = await agent.createDmWithAddress(targetAddress);
    await conversation.send(JSON.stringify({
      from_did: AGENT_DID,
      content: message,
      timestamp: new Date().toISOString(),
    }));

    console.log(JSON.stringify({
      status: "sent",
      to_did: targetDid,
      to_address: targetAddress,
      encrypted: true,
      protocol: "xmtp",
      trust: { verified: trust.verified, reputation: trust.reputation },
    }));
    process.exit(0);
  }

  case "listen": {
    const duration = parseInt(process.argv[3] || "30") * 1000;
    const agent = await Agent.createFromEnv();

    console.log(JSON.stringify({ status: "listening", address: agent.address, did: AGENT_DID, protocol: "xmtp" }));

    const timeout = setTimeout(() => {
      console.log(JSON.stringify({ status: "timeout" }));
      process.exit(0);
    }, duration);

    agent.on("text", async (ctx) => {
      const senderAddress = ctx.message?.senderAddress || "unknown";
      const text = ctx.message?.content || "";

      let content;
      try { content = JSON.parse(text); } catch { content = { content: text }; }

      let trust = null;
      if (content.from_did) trust = await verifyTrust(content.from_did);

      console.log(JSON.stringify({
        type: "message",
        from_did: content.from_did || null,
        from_address: senderAddress,
        content: content.content || text,
        encrypted: true,
        protocol: "xmtp",
        trust: trust ? { verified: trust.verified, reputation: trust.reputation } : null,
        timestamp: content.timestamp || new Date().toISOString(),
      }));
    });

    await agent.start();
    break;
  }

  case "status": {
    try {
      const agent = await Agent.createFromEnv();
      console.log(JSON.stringify({
        status: "connected",
        address: agent.address,
        did: AGENT_DID,
        env: process.env.XMTP_ENV || "production",
        protocol: "xmtp",
      }));
    } catch (e) {
      console.log(JSON.stringify({ status: "error", error: e.message }));
    }
    break;
  }

  default:
    console.log(JSON.stringify({
      commands: {
        setup: "Initialize XMTP identity (one-time)",
        address: "Show wallet address",
        map: "Map DID to address: map <did> <0x...>",
        send: "Send message: send <did> <message>",
        listen: "Listen for messages: listen [seconds]",
        status: "Check XMTP connection",
      },
    }));
}
