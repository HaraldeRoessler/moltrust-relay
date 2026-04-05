#!/bin/bash
# MolTrust Agent Relay Client (Node.js-based)

RELAY_URL="${MOLTRUST_RELAY_URL:-}"
RELAY_SECRET="${MOLTRUST_RELAY_SECRET:-}"
AGENT_DID="${MOLTRUST_AGENT_DID:-}"

command=$1
shift

case "$command" in
  status)
    node -e "
      fetch('$RELAY_URL/healthz')
        .then(r => r.json())
        .then(d => console.log(JSON.stringify(d, null, 2)))
        .catch(e => console.log(JSON.stringify({error: e.message})))
    "
    ;;

  history)
    limit=${1:-20}
    node -e "
      fetch('$RELAY_URL/messages?limit=$limit')
        .then(r => r.json())
        .then(d => console.log(JSON.stringify(d, null, 2)))
        .catch(e => console.log(JSON.stringify({error: e.message})))
    "
    ;;

  agents)
    node -e "
      fetch('$RELAY_URL/agents')
        .then(r => r.json())
        .then(d => console.log(JSON.stringify(d, null, 2)))
        .catch(e => console.log(JSON.stringify({error: e.message})))
    "
    ;;

  send)
    target_did=$1
    shift
    message="$*"
    if [ -z "$target_did" ] || [ -z "$message" ]; then
      echo '{"error": "Usage: relay.sh send <target_did> <message>"}'
      exit 1
    fi
    node -e "
      const WebSocket = require('ws');
      const url = '$RELAY_URL'.replace('https://', 'wss://').replace('http://', 'ws://');
      const ws = new WebSocket(url + '/ws/$AGENT_DID?secret=$RELAY_SECRET');
      const timeout = setTimeout(() => { ws.close(); console.log(JSON.stringify({status:'sent',note:'no response within 10s'})); }, 10000);
      ws.on('open', () => {
        ws.send(JSON.stringify({type:'message', to:'$target_did', content: \`$message\`}));
      });
      ws.on('message', (data) => {
        console.log(data.toString());
        clearTimeout(timeout);
        ws.close();
      });
      ws.on('error', (e) => {
        clearTimeout(timeout);
        console.log(JSON.stringify({error: e.message}));
      });
    " 2>&1
    ;;

  listen)
    duration=${1:-30}
    node -e "
      const WebSocket = require('ws');
      const url = '$RELAY_URL'.replace('https://', 'wss://').replace('http://', 'ws://');
      const ws = new WebSocket(url + '/ws/$AGENT_DID?secret=$RELAY_SECRET');
      const timeout = setTimeout(() => { ws.close(); console.log(JSON.stringify({status:'timeout',seconds:$duration})); }, ${duration}000);
      ws.on('open', () => {
        console.log(JSON.stringify({status:'connected',did:'$AGENT_DID'}));
      });
      ws.on('message', (data) => {
        console.log(data.toString());
      });
      ws.on('close', (code, reason) => {
        clearTimeout(timeout);
        if (code !== 1000) console.log(JSON.stringify({status:'disconnected',code:code,reason:reason.toString()}));
      });
      ws.on('error', (e) => {
        clearTimeout(timeout);
        console.log(JSON.stringify({error: e.message}));
      });
    " 2>&1
    ;;

  *)
    echo '{"error": "Unknown command. Use: status, agents, history, send, listen"}'
    exit 1
    ;;
esac
