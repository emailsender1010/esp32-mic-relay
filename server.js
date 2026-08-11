// ===========================================================================
// ESP32 mic relay  (v2 - now with talkback)
// ---------------------------------------------------------------------------
// Neither the ESP32 nor your phone can accept an inbound connection from the
// internet (CGNAT, no port forwarding). Both can make OUTBOUND connections,
// though - so both dial this server and it pipes bytes between them.
//
//   ESP32   --wss--> relay <--wss--  phone       (device mic -> phone)
//   ESP32   --GET --> relay <--wss--  phone      (phone mic -> device speaker)
//
// The downlink (phone mic -> ESP32 speaker) is deliberately NOT a WebSocket.
// The ESP32's audio library can only PULL audio from a stream, so the relay
// pretends to be an internet radio station: /talkback.wav is an endless
// 16 kHz mono WAV that the device tunes into with connecttohost(). We pace
// it at real time and pad with silence whenever nobody is speaking, so the
// stream never stalls and the library never drops the connection.
//
// Audio is raw 16 kHz mono signed 16-bit PCM, little endian, in binary
// frames. Everything else is a short text/JSON control message.
//
// PROTOCOL
//   phone  -> relay  : "start" | "stop" | "talk_start" | "talk_stop",
//                      binary audio frames (only while it holds the talk slot)
//   relay  -> device : "start" | "stop" | "talk_start" | "talk_stop"
//   device -> relay  : binary audio frames, "keepalive", "denied"
//   relay  -> phone  : binary audio frames,
//                      {"type":"device","online":bool},
//                      {"type":"talk","active":bool,"mine":bool},
//                      {"type":"error","message":"..."}
// ===========================================================================

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEVICE_TOKEN = "Esp33";
const LISTEN_TOKEN = "Listen123";
const PORT = 8080;

if (!DEVICE_TOKEN || !LISTEN_TOKEN) {
  console.error('DEVICE_TOKEN and LISTEN_TOKEN must both be set. Refusing to start.');
  process.exit(1);
}

let device = null;                 // the ESP32's control socket, at most one
const listeners = new Set();       // browsers currently connected

const listenPage = fs.readFileSync(path.join(__dirname, 'listen.html'));

// ---------------------------------------------------------------------------
// Talkback (phone mic -> ESP32 speaker)
// ---------------------------------------------------------------------------
const TALK_RATE       = 16000;                 // must match AUDIO_SAMPLE_RATE in the sketch
const TALK_BYTES_PER_MS = (TALK_RATE * 2) / 1000; // 32 bytes of PCM per millisecond
const TALK_TICK_MS    = 20;                    // how often we top the stream up
const TALK_MAX_BURST  = TALK_BYTES_PER_MS * 200; // never dump more than 200ms at once
const TALK_MAX_BACKLOG = TALK_BYTES_PER_MS * 400; // drop the oldest audio past 400ms

const SILENCE = Buffer.alloc(TALK_BYTES_PER_MS * TALK_TICK_MS);

let talker = null;               // the listener socket holding the talk slot
let talkRes = null;              // the device's open /talkback.wav response
let talkTimer = null;
let talkQueue = Buffer.alloc(0); // phone audio waiting to go out
let talkStartedAt = 0;
let talkBytesSent = 0;

// An endless WAV: 0xFFFFFFFF sizes tell the decoder "keep reading".
function endlessWavHeader(sampleRate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(0xFFFFFFFF, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);            // fmt chunk size
  h.writeUInt16LE(1, 20);             // PCM
  h.writeUInt16LE(1, 22);             // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28); // byte rate
  h.writeUInt16LE(2, 32);             // block align
  h.writeUInt16LE(16, 34);            // bits per sample
  h.write('data', 36);
  h.writeUInt32LE(0xFFFFFFFF, 40);
  return h;
}

// Writes however many bytes are due since the stream opened, so the pace
// tracks wall-clock rather than drifting with Node's timer slop.
function talkPump() {
  if (!talkRes) return;

  const due = Math.floor((Date.now() - talkStartedAt) * TALK_BYTES_PER_MS / 2) * 2;
  let owed = due - talkBytesSent;
  if (owed <= 0) return;
  if (owed > TALK_MAX_BURST) {
    // We fell badly behind (event loop stall). Skip ahead rather than
    // dumping a burst the device would have to buffer.
    talkBytesSent = due - TALK_MAX_BURST;
    owed = TALK_MAX_BURST;
  }

  while (owed > 0) {
    const n = Math.min(owed, SILENCE.length);
    let chunk;
    if (talkQueue.length >= n) {
      chunk = talkQueue.subarray(0, n);
      talkQueue = talkQueue.subarray(n);
    } else if (talkQueue.length > 0) {
      chunk = Buffer.concat([talkQueue, SILENCE.subarray(0, n - talkQueue.length)]);
      talkQueue = Buffer.alloc(0);
    } else {
      chunk = SILENCE.subarray(0, n);
    }
    talkRes.write(chunk);
    talkBytesSent += n;
    owed -= n;
  }
}

function startTalkPump() {
  stopTalkPump();
  talkQueue = Buffer.alloc(0);
  talkStartedAt = Date.now();
  talkBytesSent = 0;
  talkTimer = setInterval(talkPump, TALK_TICK_MS);
}

function stopTalkPump() {
  if (talkTimer) { clearInterval(talkTimer); talkTimer = null; }
  talkQueue = Buffer.alloc(0);
}

function releaseTalkSlot(ws) {
  if (talker !== ws) return;
  talker = null;
  talkQueue = Buffer.alloc(0);
  tellDevice('talk_stop');
  tellListeners({ type: 'talk', active: false });
  console.log('[talk] slot released');
}

// ---------------------------------------------------------------------------
// HTTP: the listener page, the talkback stream, plus a health endpoint you
// can point an uptime monitor at to keep the free instance awake.
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === '/' || url === '/listen' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(listenPage);
    return;
  }

  // The ESP32 "tunes in" here whenever talk mode is on.
  if (url === '/talkback.wav') {
    const token = new URL(req.url, 'http://relay').searchParams.get('token');
    if (!tokenMatches(token, DEVICE_TOKEN)) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }
    if (talkRes) { try { talkRes.end(); } catch (_) {} }

    talkRes = res;
   res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': '2147483647',   // "effectively endless", no chunking
      'Cache-Control': 'no-store',
      'Connection': 'close'
    });
    res.write(endlessWavHeader(TALK_RATE));
    startTalkPump();
    console.log('[talk] device tuned in');

    const done = () => {
      if (talkRes === res) { talkRes = null; stopTalkPump(); console.log('[talk] device stream closed'); }
    };
    req.on('close', done);
    res.on('close', done);
    return;
  }

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      deviceOnline: !!device,
      listeners: listeners.size,
      talkActive: !!talker,
      talkStreamOpen: !!talkRes,
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
    if (talker) ws.send('talk_start');

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        for (const l of listeners) if (l.readyState === 1) l.send(data, { binary: true });
        return;
      }
      const text = data.toString().trim();
      if (text === 'denied') {
        tellListeners({ type: 'error', message: 'The device has remote listening switched off.' });
      }
      if (text === 'talk_denied') {
        tellListeners({ type: 'error', message: 'The device has talkback switched off.' });
        if (talker) releaseTalkSlot(talker);
      }
      // "keepalive" needs no handling - receiving it is the entire point
      // (it delays Render's free-tier spindown).
    });

    ws.on('close', () => {
      if (device === ws) {
        device = null;
        console.log('[device] disconnected');
        tellListeners({ type: 'device', online: false });
        if (talker) releaseTalkSlot(talker);
      }
    });
    return;
  }

  // ---- a browser ----
  if (role === 'listen' && tokenMatches(token, LISTEN_TOKEN)) {
    listeners.add(ws);
    console.log('[listener] connected, now', listeners.size);
    ws.send(JSON.stringify({ type: 'device', online: !!device }));
    ws.send(JSON.stringify({ type: 'talk', active: !!talker, mine: false }));

    ws.on('message', (data, isBinary) => {
      // Binary from a browser is its microphone, and only the phone
      // currently holding the talk slot is allowed to send it.
      if (isBinary) {
        if (ws !== talker) return;
        talkQueue = Buffer.concat([talkQueue, Buffer.from(data)]);
        if (talkQueue.length > TALK_MAX_BACKLOG) {
          talkQueue = talkQueue.subarray(talkQueue.length - TALK_MAX_BACKLOG);
        }
        return;
      }

      const cmd = data.toString().trim();

      if (cmd === 'start' || cmd === 'stop') {
        if (!tellDevice(cmd)) {
          ws.send(JSON.stringify({ type: 'error', message: 'The device is not connected to the relay.' }));
        }
        return;
      }

      if (cmd === 'talk_start') {
        if (!device) {
          ws.send(JSON.stringify({ type: 'error', message: 'The device is not connected to the relay.' }));
          return;
        }
        if (talker && talker !== ws) {
          ws.send(JSON.stringify({ type: 'error', message: 'Someone else is talking right now.' }));
          return;
        }
        talker = ws;
        talkQueue = Buffer.alloc(0);
        tellDevice('talk_start');
        tellListeners({ type: 'talk', active: true });
        ws.send(JSON.stringify({ type: 'talk', active: true, mine: true }));
        console.log('[talk] slot taken');
        return;
      }

      if (cmd === 'talk_stop') {
        releaseTalkSlot(ws);
        return;
      }
    });

    ws.on('close', () => {
      listeners.delete(ws);
      releaseTalkSlot(ws);
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
