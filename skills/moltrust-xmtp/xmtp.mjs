#!/usr/bin/env node
/**
 * MolTrust XMTP Agent Messenger
 *
 * Decentralized E2E encrypted messaging between MolTrust agents
 * using the XMTP network. No relay server needed.
 */
import pkg from "@xmtp/xmtp-js";
const { Client } = pkg;
import { ethers } from "ethers";
import { randomBytes } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const KEYS_DIR = process.env.MOLTRUST_KEYS_DIR || "/home/node/.openclaw/xmtp-keys";
const AGENT_DID = process.env.MOLTRUST_AGENT_DID || "";
const MOLTRUST_API_URL = process.env.MOLTRUST_API_URL || "https://api.moltrust.ch";
const MOLTRUST_API_KEY = process.env.MOLTRUST_API_KEY || "";

mkdirSync(KEYS_DIR, { recursive: true });

function getOrCreateWallet() {
  const keyFile = join(KEYS_DIR, "wallet.key");
  let privateKey;
  if (existsSync(keyFile)) {
    privateKey = readFileSync(keyFile, "utf8").trim();
  } else {
    privateKey = "0x" + randomBytes(32).toString("hex");
    writeFileSync(keyFile, privateKey, { mode: 0o600 });
  }
  return new ethers.Wallet(privateKey);
}

function loadDidMap() {
  const mapFile = join(KEYS_DIR, "did-address-map.json");
  if (existsSync(mapFile)) return JSON.parse(readFileSync(mapFile, "utf8"));
  return {};
}

function saveDidMap(mapping) {
  writeFileSync(join(KEYS_DIR, "did-address-map.json"), JSON.stringify(mapping, null, 2));
}

async function resolveDidToAddress(did) {
  const mapping = loadDidMap();
  if (mapping[did]) return mapping[did];
  try {
    const resp = await fetch(`${MOLTRUST_API_URL}/identity/resolve/${encodeURIComponent(did)}`, {
      headers: MOLTRUST_API_KEY ? { "X-API-Key": MOLTRUST_API_KEY } : {},
    });
    if (resp.ok) {
      const doc = await resp.json();
      const svc = doc.service?.find(s => s.type?.includes("Payment") || s.type?.includes("XMTP"));
      if (svc?.serviceEndpoint) {
        mapping[did] = svc.serviceEndpoint;
        saveDidMap(mapping);
        return svc.serviceEndpoint;
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}

async function verifyTrust(did) {
  try {
    const resp = await fetch(`${MOLTRUST_API_URL}/identity/verify/${encodeURIComponent(did)}`, {
      headers: MOLTRUST_API_KEY ? { "X-API-Key": MOLTRUST_API_KEY } : {},
    });
    if (resp.ok) return await resp.json();
  } catch (e) { /* ignore */ }
  return { did, verified: false };
}

async function createXmtpClient(wallet) {
  const client = await Client.create(wallet, { env: "production" });
  return client;
}

const command = process.argv[2];

switch (command) {
  case "setup": {
    const wallet = getOrCreateWallet();
    const mapping = loadDidMap();
    mapping[AGENT_DID] = wallet.address;
    saveDidMap(mapping);
    console.log(JSON.stringify({
      status: "ready",
      did: AGENT_DID,
      address: wallet.address,
      note: "Share your address with peer agents: xmtp.mjs map <their_did> <their_address>",
    }));
    break;
  }

  case "address": {
    const wallet = getOrCreateWallet();
    console.log(JSON.stringify({ did: AGENT_DID, address: wallet.address }));
    break;
  }

  case "map": {
    const did = process.argv[3];
    const addr = process.argv[4];
    if (!did || !addr) {
      console.log(JSON.stringify({ error: "Usage: xmtp.mjs map <did> <address>" }));
      process.exit(1);
    }
    const mapping = loadDidMap();
    mapping[did] = addr;
    saveDidMap(mapping);
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
      console.log(JSON.stringify({ error: `Agent ${targetDid} not verified by MolTrust`, trust }));
      process.exit(1);
    }

    const targetAddress = await resolveDidToAddress(targetDid);
    if (!targetAddress) {
      console.log(JSON.stringify({ error: `Cannot resolve ${targetDid}. Run: xmtp.mjs map ${targetDid} <address>` }));
      process.exit(1);
    }

    const wallet = getOrCreateWallet();
    const client = await createXmtpClient(wallet);

    const canMessage = await client.canMessage(targetAddress);
    if (!canMessage) {
      console.log(JSON.stringify({ error: `${targetAddress} not on XMTP network. Target agent must run: xmtp.mjs setup` }));
      process.exit(1);
    }

    const conversation = await client.conversations.newConversation(targetAddress);
    await conversation.send(JSON.stringify({
      from: AGENT_DID,
      content: message,
      timestamp: new Date().toISOString(),
    }));

    console.log(JSON.stringify({
      status: "sent",
      to: targetDid,
      address: targetAddress,
      encrypted: true,
      protocol: "xmtp",
      trust: { verified: trust.verified, reputation: trust.reputation },
    }));
    process.exit(0);
  }

  case "listen": {
    const duration = parseInt(process.argv[3] || "30") * 1000;
    const wallet = getOrCreateWallet();
    const client = await createXmtpClient(wallet);

    console.log(JSON.stringify({ status: "listening", did: AGENT_DID, address: wallet.address, protocol: "xmtp" }));

    const timeout = setTimeout(() => {
      console.log(JSON.stringify({ status: "timeout" }));
      process.exit(0);
    }, duration);

    for await (const message of await client.conversations.streamAllMessages()) {
      if (message.senderAddress === wallet.address) continue;

      let content;
      try { content = JSON.parse(message.content); } catch { content = { content: message.content }; }

      let trust = null;
      if (content.from) trust = await verifyTrust(content.from);

      console.log(JSON.stringify({
        type: "message",
        from: content.from || message.senderAddress,
        content: content.content || message.content,
        encrypted: true,
        protocol: "xmtp",
        trust: trust ? { verified: trust.verified, reputation: trust.reputation } : null,
        timestamp: content.timestamp || message.sent?.toISOString(),
      }));
    }
    clearTimeout(timeout);
    break;
  }

  case "status": {
    const wallet = getOrCreateWallet();
    try {
      const client = await createXmtpClient(wallet);
      console.log(JSON.stringify({
        status: "ok",
        did: AGENT_DID,
        address: wallet.address,
        xmtp: "connected",
        protocol: "xmtp",
      }));
    } catch (e) {
      console.log(JSON.stringify({ status: "error", did: AGENT_DID, address: wallet.address, error: e.message }));
    }
    break;
  }

  default:
    console.log(JSON.stringify({
      error: "Unknown command",
      commands: { setup: "Init wallet + XMTP", address: "Show address", map: "Map DID to address", send: "Send message", listen: "Listen", status: "Check connection" },
    }));
}
