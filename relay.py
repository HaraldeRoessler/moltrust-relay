"""MolTrust Agent Relay — WebSocket message relay for trusted agents.

Only allows connections from pre-approved DIDs.
Verifies trust via MolTrust API before accepting connections.
Messages are forwarded to all other connected agents.
"""
import os
import json
import logging
from datetime import datetime, timezone
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
import httpx

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("moltrust-relay")

app = FastAPI(title="MolTrust Agent Relay")

# Only these DIDs can connect
ALLOWED_DIDS = set(os.environ.get("ALLOWED_DIDS", "").split(","))
MOLTRUST_API_URL = os.environ.get("MOLTRUST_API_URL", "https://api.moltrust.ch")
MOLTRUST_API_KEY = os.environ.get("MOLTRUST_API_KEY", "")
RELAY_SECRET = os.environ.get("RELAY_SECRET", "")

# Connected agents: did -> websocket
connected_agents: dict[str, WebSocket] = {}
# Message log for audit
message_log: list[dict] = []


async def verify_agent(did: str) -> dict:
    """Verify agent DID via MolTrust API."""
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
        logger.error(f"MolTrust verification failed for {did}: {e}")
    return {"did": did, "verified": False, "reputation": 0.0}


@app.get("/healthz")
async def healthz():
    return {
        "status": "ok",
        "connected_agents": list(connected_agents.keys()),
        "allowed_dids": list(ALLOWED_DIDS),
        "message_count": len(message_log),
    }


@app.get("/agents")
async def list_agents():
    """List currently connected agents."""
    return {
        "agents": [
            {"did": did, "connected": True}
            for did in connected_agents.keys()
        ],
        "total": len(connected_agents),
    }


@app.get("/messages")
async def list_messages(limit: int = 50):
    """List recent messages (audit log)."""
    return {"messages": message_log[-limit:], "total": len(message_log)}


@app.websocket("/ws/{did}")
async def websocket_endpoint(websocket: WebSocket, did: str):
    # Check relay secret (connection auth)
    secret = websocket.query_params.get("secret", "")
    if RELAY_SECRET and secret != RELAY_SECRET:
        await websocket.close(code=4001, reason="Invalid relay secret")
        return

    # Check DID is in allowlist
    if did not in ALLOWED_DIDS:
        await websocket.close(code=4003, reason=f"DID not allowed: {did}")
        logger.warning(f"Rejected connection from unknown DID: {did}")
        return

    # Verify via MolTrust
    verification = await verify_agent(did)
    if not verification.get("verified"):
        await websocket.close(code=4004, reason=f"DID not verified by MolTrust: {did}")
        logger.warning(f"Rejected unverified DID: {did}")
        return

    # Accept connection
    await websocket.accept()
    connected_agents[did] = websocket
    logger.info(f"Agent connected: {did} (total: {len(connected_agents)})")

    # Notify other agents
    await broadcast(did, {
        "type": "agent.connected",
        "from": did,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })

    try:
        while True:
            data = await websocket.receive_text()
            try:
                message = json.loads(data)
            except json.JSONDecodeError:
                await websocket.send_text(json.dumps({
                    "type": "error",
                    "error": "Invalid JSON",
                }))
                continue

            # Stamp the message
            message["from"] = did
            message["timestamp"] = datetime.now(timezone.utc).isoformat()
            message["relay_verified"] = True

            # Log for audit
            message_log.append(message)
            if len(message_log) > 1000:
                message_log.pop(0)

            # Route message
            target = message.get("to")
            if target:
                # Direct message to specific agent
                if target in connected_agents:
                    await connected_agents[target].send_text(json.dumps(message))
                    logger.info(f"Message: {did} -> {target}: {message.get('type', 'unknown')}")
                else:
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "error": f"Agent not connected: {target}",
                    }))
            else:
                # Broadcast to all other agents
                await broadcast(did, message)

    except WebSocketDisconnect:
        pass
    finally:
        connected_agents.pop(did, None)
        logger.info(f"Agent disconnected: {did} (total: {len(connected_agents)})")
        await broadcast(did, {
            "type": "agent.disconnected",
            "from": did,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })


async def broadcast(sender_did: str, message: dict):
    """Send message to all connected agents except sender."""
    text = json.dumps(message)
    disconnected = []
    for did, ws in connected_agents.items():
        if did != sender_did:
            try:
                await ws.send_text(text)
            except Exception:
                disconnected.append(did)
    for did in disconnected:
        connected_agents.pop(did, None)
