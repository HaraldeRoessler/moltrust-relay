#!/bin/bash
# MolTrust Agent Relay Client (Node.js-based) with E2E encryption

RELAY_URL="${MOLTRUST_RELAY_URL:-}"
RELAY_SECRET="${MOLTRUST_RELAY_SECRET:-}"
AGENT_DID="${MOLTRUST_AGENT_DID:-}"
KEYS_DIR="${MOLTRUST_KEYS_DIR:-/home/node/.openclaw/relay-keys}"

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

  keygen)
    node -e "
      const crypto = require('crypto');
      const fs = require('fs');
      const dir = '$KEYS_DIR';
      const peersDir = dir + '/peers';
      fs.mkdirSync(peersDir, { recursive: true });

      if (fs.existsSync(dir + '/private.key')) {
        console.log(JSON.stringify({status: 'exists', publicKey: fs.readFileSync(dir + '/public.key', 'utf8').trim()}));
        process.exit(0);
      }

      const keypair = crypto.generateKeyPairSync('x25519');
      const privDer = keypair.privateKey.export({ type: 'pkcs8', format: 'der' });
      const pubDer = keypair.publicKey.export({ type: 'spki', format: 'der' });
      const privHex = privDer.toString('hex');
      const pubHex = pubDer.toString('hex');

      fs.writeFileSync(dir + '/private.key', privHex, { mode: 0o600 });
      fs.writeFileSync(dir + '/public.key', pubHex, { mode: 0o644 });

      console.log(JSON.stringify({status: 'generated', publicKey: pubHex, keysDir: dir}));
    " 2>&1
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
      const crypto = require('crypto');
      const fs = require('fs');
      const WebSocket = require('ws');
      const dir = '$KEYS_DIR';
      const peersDir = dir + '/peers';

      if (!fs.existsSync(dir + '/private.key')) {
        console.log(JSON.stringify({error: 'No keys. Run: relay.sh keygen'}));
        process.exit(1);
      }
      const privHex = fs.readFileSync(dir + '/private.key', 'utf8').trim();
      const pubHex = fs.readFileSync(dir + '/public.key', 'utf8').trim();
      const privateKey = crypto.createPrivateKey({ key: Buffer.from(privHex, 'hex'), format: 'der', type: 'pkcs8' });

      function loadPeerKey() {
        const peerFile = peersDir + '/' + '$target_did'.replace(/:/g, '_') + '.pub';
        if (fs.existsSync(peerFile)) {
          const peerHex = fs.readFileSync(peerFile, 'utf8').trim();
          return crypto.createPublicKey({ key: Buffer.from(peerHex, 'hex'), format: 'der', type: 'spki' });
        }
        return null;
      }

      function encryptAndSend(ws, peerPubKey) {
        const shared = crypto.diffieHellman({ privateKey, publicKey: peerPubKey });
        const key = crypto.createHash('sha256').update(shared).digest();
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        let encrypted = cipher.update('$message', 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const tag = cipher.getAuthTag().toString('hex');
        ws.send(JSON.stringify({
          type: 'encrypted_message',
          to: '$target_did',
          iv: iv.toString('hex'),
          tag: tag,
          ciphertext: encrypted,
          senderPublicKey: pubHex
        }));
        console.log(JSON.stringify({status: 'sent', encrypted: true, to: '$target_did'}));
      }

      const url = '$RELAY_URL'.replace('https://', 'wss://').replace('http://', 'ws://');
      const ws = new WebSocket(url + '/ws/$AGENT_DID?secret=$RELAY_SECRET');
      let messageSent = false;
      const timeout = setTimeout(() => { ws.close(); if (!messageSent) console.log(JSON.stringify({status:'timeout'})); }, 15000);

      ws.on('open', () => {
        ws.send(JSON.stringify({type:'key_exchange', publicKey: pubHex}));
        // Check if we already have the peer key
        const peerPubKey = loadPeerKey();
        if (peerPubKey) {
          encryptAndSend(ws, peerPubKey);
          messageSent = true;
          clearTimeout(timeout);
          setTimeout(() => ws.close(), 1000);
        }
        // Otherwise wait for key_exchange response
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'key_exchange' && msg.publicKey && msg.from) {
          const pf = peersDir + '/' + msg.from.replace(/:/g, '_') + '.pub';
          fs.mkdirSync(peersDir, { recursive: true });
          fs.writeFileSync(pf, msg.publicKey);
          console.log(JSON.stringify({status: 'peer_key_received', from: msg.from}));
          if (!messageSent && msg.from === '$target_did') {
            const peerPubKey = crypto.createPublicKey({ key: Buffer.from(msg.publicKey, 'hex'), format: 'der', type: 'spki' });
            encryptAndSend(ws, peerPubKey);
            messageSent = true;
            clearTimeout(timeout);
            setTimeout(() => ws.close(), 1000);
          }
        } else if (!messageSent) {
          // Skip non-key messages while waiting
        } else {
          console.log(data.toString());
          clearTimeout(timeout);
          ws.close();
        }
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
      const crypto = require('crypto');
      const fs = require('fs');
      const WebSocket = require('ws');
      const dir = '$KEYS_DIR';
      const peersDir = dir + '/peers';

      // Load own keys
      if (!fs.existsSync(dir + '/private.key')) {
        console.log(JSON.stringify({error: 'No keys. Run: relay.sh keygen'}));
        process.exit(1);
      }
      const privHex = fs.readFileSync(dir + '/private.key', 'utf8').trim();
      const pubHex = fs.readFileSync(dir + '/public.key', 'utf8').trim();
      const privateKey = crypto.createPrivateKey({ key: Buffer.from(privHex, 'hex'), format: 'der', type: 'pkcs8' });

      const url = '$RELAY_URL'.replace('https://', 'wss://').replace('http://', 'ws://');
      const ws = new WebSocket(url + '/ws/$AGENT_DID?secret=$RELAY_SECRET');
      const timeout = setTimeout(() => { ws.close(); console.log(JSON.stringify({status:'timeout',seconds:$duration})); }, ${duration}000);

      ws.on('open', () => {
        // Announce public key
        ws.send(JSON.stringify({type:'key_exchange', publicKey: pubHex}));
        console.log(JSON.stringify({status:'connected',did:'$AGENT_DID',encrypted:true}));
      });
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());

        // Handle key exchange
        if (msg.type === 'key_exchange' && msg.publicKey && msg.from) {
          const pf = peersDir + '/' + msg.from.replace(/:/g, '_') + '.pub';
          fs.mkdirSync(peersDir, { recursive: true });
          fs.writeFileSync(pf, msg.publicKey);
          console.log(JSON.stringify({status: 'peer_key_saved', from: msg.from}));
          return;
        }

        // Handle encrypted message
        if (msg.type === 'encrypted_message' && msg.ciphertext && msg.senderPublicKey) {
          try {
            const peerPubKey = crypto.createPublicKey({ key: Buffer.from(msg.senderPublicKey, 'hex'), format: 'der', type: 'spki' });
            const shared = crypto.diffieHellman({ privateKey, publicKey: peerPubKey });
            const key = crypto.createHash('sha256').update(shared).digest();
            const iv = Buffer.from(msg.iv, 'hex');
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(Buffer.from(msg.tag, 'hex'));
            let decrypted = decipher.update(msg.ciphertext, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            console.log(JSON.stringify({
              type: 'decrypted_message',
              from: msg.from,
              content: decrypted,
              encrypted: true,
              verified: true,
              timestamp: msg.timestamp
            }));

            // Save peer key
            if (msg.from) {
              const pf = peersDir + '/' + msg.from.replace(/:/g, '_') + '.pub';
              fs.writeFileSync(pf, msg.senderPublicKey);
            }
          } catch (e) {
            console.log(JSON.stringify({error: 'Decryption failed: ' + e.message, raw: msg}));
          }
          return;
        }

        // Handle unencrypted message (fallback)
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
    echo '{"error": "Unknown command. Use: status, keygen, send, listen"}'
    exit 1
    ;;
esac
