#!/usr/bin/env node
/**
 * MolTrust WebRTC Agent Messenger
 *
 * P2P encrypted messaging between agents using WebRTC data channels.
 * Signal server only used for initial handshake — all messages go directly
 * between agents, never through any server.
 */
const { RTCPeerConnection } = require("werift");
const WebSocket = require("ws");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SIGNAL_URL = process.env.MOLTRUST_SIGNAL_URL || "";
const SIGNAL_SECRET = process.env.MOLTRUST_SIGNAL_SECRET || "";
const AGENT_DID = process.env.MOLTRUST_AGENT_DID || "";
const MOLTRUST_API_URL = process.env.MOLTRUST_API_URL || "https://api.moltrust.ch";
const MOLTRUST_API_KEY = process.env.MOLTRUST_API_KEY || "";

const STUN_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

// Active P2P connections
const peers = {};  // did -> { pc, channel, connected }

async function verifyTrust(did) {
  try {
    const resp = await fetch(`${MOLTRUST_API_URL}/identity/verify/${encodeURIComponent(did)}`, {
      headers: MOLTRUST_API_KEY ? { "X-API-Key": MOLTRUST_API_KEY } : {},
    });
    if (resp.ok) return await resp.json();
  } catch (e) { /* ignore */ }
  return { did, verified: false };
}

function connectSignal() {
  return new Promise((resolve, reject) => {
    const url = SIGNAL_URL.replace("https://", "wss://").replace("http://", "ws://");
    const ws = new WebSocket(`${url}/signal/${AGENT_DID}?secret=${SIGNAL_SECRET}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", (e) => reject(e));
  });
}

async function createPeerConnection(targetDid, signalWs, isInitiator) {
  const pc = new RTCPeerConnection({
    iceServers: STUN_SERVERS,
  });

  const peer = { pc, channel: null, connected: false, messages: [] };
  peers[targetDid] = peer;

  // Send ICE candidates to peer via signal server
  pc.onIceCandidate.subscribe((candidate) => {
    if (candidate) {
      signalWs.send(JSON.stringify({
        type: "ice-candidate",
        to: targetDid,
        candidate: candidate,
      }));
    }
  });

  if (isInitiator) {
    // Create data channel
    const channel = pc.createDataChannel("moltrust-messages");
    peer.channel = channel;

    channel.onMessage.subscribe((data) => {
      handleIncomingMessage(targetDid, Buffer.from(data).toString());
    });

    channel.stateChanged.subscribe((state) => {
      if (state === "open") {
        peer.connected = true;
        console.log(JSON.stringify({ status: "p2p-connected", peer: targetDid, initiator: true }));
      }
      if (state === "closed") {
        peer.connected = false;
      }
    });

    // Create and send offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signalWs.send(JSON.stringify({
      type: "offer",
      to: targetDid,
      sdp: JSON.stringify(pc.localDescription),
    }));
  } else {
    // Wait for data channel from peer
    pc.onDataChannel.subscribe((channel) => {
      peer.channel = channel;

      channel.message.subscribe((data) => {
        handleIncomingMessage(targetDid, Buffer.from(data).toString());
      });

      channel.stateChanged.subscribe((state) => {
        if (state === "open") {
          peer.connected = true;
          console.log(JSON.stringify({ status: "p2p-connected", peer: targetDid, initiator: false }));
        }
        if (state === "closed") {
          peer.connected = false;
        }
      });
    });
  }

  return peer;
}

function handleIncomingMessage(fromDid, raw) {
  try {
    const msg = JSON.parse(raw);
    console.log(JSON.stringify({
      type: "message",
      from: fromDid,
      content: msg.content,
      encrypted: true,
      protocol: "webrtc-p2p",
      timestamp: msg.timestamp,
    }));
  } catch (e) {
    console.log(JSON.stringify({
      type: "message",
      from: fromDid,
      content: raw,
      encrypted: true,
      protocol: "webrtc-p2p",
    }));
  }
}

async function handleSignalMessage(msg, signalWs) {
  const fromDid = msg.from;

  if (msg.type === "offer") {
    // Incoming connection request — create peer and answer
    const trust = await verifyTrust(fromDid);
    if (!trust.verified) {
      console.log(JSON.stringify({ error: `Rejected offer from unverified agent: ${fromDid}` }));
      return;
    }

    const peer = await createPeerConnection(fromDid, signalWs, false);
    await peer.pc.setRemoteDescription(JSON.parse(msg.sdp));
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    signalWs.send(JSON.stringify({
      type: "answer",
      to: fromDid,
      sdp: JSON.stringify(peer.pc.localDescription),
    }));
  }

  if (msg.type === "answer") {
    const peer = peers[fromDid];
    if (peer) {
      await peer.pc.setRemoteDescription(JSON.parse(msg.sdp));
    }
  }

  if (msg.type === "ice-candidate") {
    const peer = peers[fromDid];
    if (peer && msg.candidate) {
      await peer.pc.addIceCandidate(msg.candidate);
    }
  }

  if (msg.type === "peer-available") {
    console.log(JSON.stringify({ status: "peer-available", did: msg.did }));
  }

  if (msg.type === "peer-disconnected") {
    const peer = peers[msg.did];
    if (peer) {
      peer.pc.close();
      delete peers[msg.did];
    }
    console.log(JSON.stringify({ status: "peer-disconnected", did: msg.did }));
  }
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function main() {
  const command = process.argv[2];

  switch (command) {
    case "connect": {
      const targetDid = process.argv[3];
      const duration = parseInt(process.argv[4] || "60") * 1000;

      const signalWs = await connectSignal();
      console.log(JSON.stringify({ status: "signal-connected", did: AGENT_DID }));

      if (targetDid) {
        const trust = await verifyTrust(targetDid);
        if (!trust.verified) {
          console.log(JSON.stringify({ error: `Agent ${targetDid} not verified` }));
          process.exit(1);
        }
        await createPeerConnection(targetDid, signalWs, true);
        console.log(JSON.stringify({ status: "connecting-to-peer", did: targetDid }));
      }

      signalWs.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        handleSignalMessage(msg, signalWs);
      });

      setTimeout(() => {
        console.log(JSON.stringify({ status: "timeout" }));
        Object.values(peers).forEach(p => p.pc.close());
        signalWs.close();
        process.exit(0);
      }, duration);

      break;
    }

    case "send": {
      const targetDid = process.argv[3];
      const message = process.argv.slice(4).join(" ");
      if (!targetDid || !message) {
        console.log(JSON.stringify({ error: "Usage: webrtc.js send <did> <message>" }));
        process.exit(1);
      }

      const trust = await verifyTrust(targetDid);
      if (!trust.verified) {
        console.log(JSON.stringify({ error: `Agent ${targetDid} not verified` }));
        process.exit(1);
      }

      const signalWs = await connectSignal();
      console.log(JSON.stringify({ status: "signal-connected", did: AGENT_DID }));

      const peer = await createPeerConnection(targetDid, signalWs, true);

      signalWs.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        handleSignalMessage(msg, signalWs);
      });

      const checkInterval = setInterval(() => {
        if (peer.connected && peer.channel) {
          peer.channel.send(JSON.stringify({
            from: AGENT_DID,
            content: message,
            timestamp: new Date().toISOString(),
          }));
          console.log(JSON.stringify({
            status: "sent",
            to: targetDid,
            protocol: "webrtc-p2p",
            encrypted: true,
            note: "Message sent directly P2P — no server involved",
          }));
          clearInterval(checkInterval);
          setTimeout(() => {
            peer.pc.close();
            signalWs.close();
            process.exit(0);
          }, 5000);
        }
      }, 100);

      setTimeout(() => {
        if (!peer.connected) {
          console.log(JSON.stringify({ error: "P2P connection timeout. Is the target agent connected to signal server?" }));
          clearInterval(checkInterval);
          signalWs.close();
          process.exit(1);
        }
      }, 15000);

      break;
    }

    case "status": {
      console.log(JSON.stringify({
        did: AGENT_DID,
        signalUrl: SIGNAL_URL,
        peers: Object.entries(peers).map(([did, p]) => ({
          did,
          connected: p.connected,
        })),
        protocol: "webrtc-p2p",
        stunServers: STUN_SERVERS.map(s => s.urls),
      }));
      break;
    }

    default:
      console.log(JSON.stringify({
        error: "Unknown command",
        commands: {
          connect: "Connect and listen: connect [target_did] [seconds]",
          send: "Send P2P message: send <did> <message>",
          status: "Show connection status",
        },
      }));
  }
}

main().catch(e => {
  console.log(JSON.stringify({ error: e.message }));
  process.exit(1);
});
