"""MolTrust Signal Server — WebRTC signaling only.

Exchanges ICE candidates and SDP offers between agents.
Never sees actual messages — those go P2P via WebRTC.

This server can be replaced by storing signaling data
in MolTrust DID documents (future).
"""
import os
import json
import logging
from datetime import datetime, timezone
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Header
import httpx

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("moltrust-signal")

app = FastAPI(title="MolTrust Signal Server")

ALLOWED_DIDS = set(os.environ.get("ALLOWED_DIDS", "").split(","))
MOLTRUST_API_URL = os.environ.get("MOLTRUST_API_URL", "https://api.moltrust.ch")
MOLTRUST_API_KEY = os.environ.get("MOLTRUST_API_KEY", "")
RELAY_SECRET = os.environ.get("RELAY_SECRET", "")

# Connected agents waiting for signaling
agents: dict[str, WebSocket] = {}


async def verify_agent(did: str) -> dict:
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{MOLTRUST_API_URL}/identity/verify/{did}",
                headers={"X-API-Key": MOLTRUST_API_KEY} if MOLTRUST_API_KEY else {},
                timeout=10.0,
            )
            if resp.status_code == 200:
                return resp.json()
    except Exception as e:
        logger.error(f"Verification failed for {did}: {e}")
    return {"did": did, "verified": False}


@app.get("/healthz")
async def healthz():
    return {
        "status": "ok",
        "type": "signal-server",
        "connected_agents": list(agents.keys()),
        "note": "Signaling only — no messages pass through this server",
    }


@app.websocket("/signal/{did}")
async def signal_endpoint(websocket: WebSocket, did: str):
    secret = websocket.query_params.get("secret", "")
    if RELAY_SECRET and secret != RELAY_SECRET:
        await websocket.close(code=4001, reason="Invalid secret")
        return

    if did not in ALLOWED_DIDS:
        await websocket.close(code=4003, reason="DID not allowed")
        return

    verification = await verify_agent(did)
    if not verification.get("verified"):
        await websocket.close(code=4004, reason="DID not verified")
        return

    await websocket.accept()
    agents[did] = websocket
    logger.info(f"Agent connected for signaling: {did}")

    # Notify others that this agent is available
    for other_did, other_ws in agents.items():
        if other_did != did:
            try:
                await other_ws.send_text(json.dumps({
                    "type": "peer-available",
                    "did": did,
                }))
            except Exception:
                pass

    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)

            # Only forward signaling messages: offer, answer, ice-candidate
            msg_type = msg.get("type")
            if msg_type not in ("offer", "answer", "ice-candidate"):
                await websocket.send_text(json.dumps({
                    "type": "error",
                    "error": f"Invalid signal type: {msg_type}. Only offer/answer/ice-candidate allowed.",
                }))
                continue

            target = msg.get("to")
            if not target or target not in agents:
                await websocket.send_text(json.dumps({
                    "type": "error",
                    "error": f"Target agent not connected: {target}",
                }))
                continue

            # Forward signaling data (SDP/ICE only, never message content)
            msg["from"] = did
            await agents[target].send_text(json.dumps(msg))
            logger.info(f"Signal: {did} -> {target} ({msg_type})")

    except WebSocketDisconnect:
        pass
    finally:
        agents.pop(did, None)
        logger.info(f"Agent disconnected: {did}")
        for other_did, other_ws in agents.items():
            try:
                await other_ws.send_text(json.dumps({
                    "type": "peer-disconnected",
                    "did": did,
                }))
            except Exception:
                pass
