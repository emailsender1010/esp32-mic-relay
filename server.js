// ===========================================================================
// ESP32 mic relay
// ---------------------------------------------------------------------------
// Neither the ESP32 nor your phone can accept an inbound connection from the
// internet (CGNAT, no port forwarding). Both can make OUTBOUND connections,
// though - so both dial this server and it pipes bytes between them.
//
//   ESP32   --wss--> relay <--wss--  phone
//           (role=device)    (role=listen)
//
// Audio is raw 16 kHz mono signed 16-bit PCM, little endian, in binary
// frames. Everything else is a short text/JSON control message.
//
// PROTOCOL
//   phone  -> relay  : "start" | "stop"
//   relay  -> device : "start" | "stop"
//   device -> relay  : binary audio frames, "keepalive", "denied"
//   relay  -> phone  : binary audio frames,
//                      {"type":"device","online":bool},
//                      {"type":"error","message":"..."}
// ===========================================================================

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEVICE_TOKEN ="Esp33";
const LISTEN_TOKEN = "Listen123";
const PORT =  8080;

if (!DEVICE_TOKEN || !LISTEN_TOKEN) {
  console.error('DEVICE_TOKEN and LISTEN_TOKEN must both be set. Refusing to start.');
  process.exit(1);
}

let device = null;                 // the ESP32, at most one at a time
const listeners = new Set();       // browsers currently connected

const listenPage = fs.readFileSync(path.join(__dirname, 'listen.html'));

// ---------------------------------------------------------------------------
// HTTP: the listener page, plus a health endpoint you can point an uptime
// monitor at if you ever want to keep the free instance awake from outside.
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === '/' || url === '/listen' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(listenPage);
    return;
  }
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      deviceOnline: !!device,
      listeners: listeners.size,
      uptimeSeconds: Math.round(process.uptime())
    }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const wss = new WebSocketServer({ server });

function tellListeners(obj) {
  const msg = JSON.stringify(obj);
  for (const l of listeners) if (l.readyState === 1) l.send(msg);
}

function tellDevice(cmd) {
  if (device && device.readyState === 1) {
    device.send(cmd);
    return true;
  }
  return false;
}

// Constant-time-ish compare so a token can't be guessed byte by byte from
// response timing. Overkill for a desk gadget, cheap enough to just do.
function tokenMatches(given, expected) {
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://relay').searchParams;
  const role = params.get('role');
  const token = params.get('token');

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // ---- the ESP32 ----
  if (role === 'device' && tokenMatches(token, DEVICE_TOKEN)) {
    if (device && device !== ws) {
      // A reboot leaves the old socket half-open for a while. Newest wins.
      try { device.close(); } catch (_) {}
    }
    device = ws;
    console.log('[device] connected');
    tellListeners({ type: 'device', online: true });

    // If someone is already waiting, start streaming straight away.
    if (listeners.size > 0) ws.send('start');

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        for (const l of listeners) if (l.readyState === 1) l.send(data, { binary: true });
        return;
      }
      const text = data.toString().trim();
      if (text === 'denied') {
        tellListeners({ type: 'error', message: 'The device has remote listening switched off.' });
      }
      // "keepalive" needs no handling - receiving it is the entire point
      // (it delays Render's free-tier spindown).
    });

    ws.on('close', () => {
      if (device === ws) {
        device = null;
        console.log('[device] disconnected');
        tellListeners({ type: 'device', online: false });
      }
    });
    return;
  }

  // ---- a browser ----
  if (role === 'listen' && tokenMatches(token, LISTEN_TOKEN)) {
    listeners.add(ws);
    console.log('[listener] connected, now', listeners.size);
    ws.send(JSON.stringify({ type: 'device', online: !!device }));

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;                       // listeners never send audio
      const cmd = data.toString().trim();
      if (cmd !== 'start' && cmd !== 'stop') return;
      if (!tellDevice(cmd)) {
        ws.send(JSON.stringify({ type: 'error', message: 'The device is not connected to the relay.' }));
      }
    });

    ws.on('close', () => {
      listeners.delete(ws);
      console.log('[listener] disconnected, now', listeners.size);
      // Nobody is listening any more, so close the mic. Without this, a
      // phone that loses signal mid-session leaves the mic open indefinitely.
      if (listeners.size === 0) tellDevice('stop');
    });
    return;
  }

  // ---- anyone else ----
  ws.close(1008, 'Unauthorized');
});

// Reap dead sockets. A phone that drops off mobile data without a clean
// close would otherwise stay in `listeners` forever, and the mic with it.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  }
}, 20000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('relay listening on ' + PORT);
});
