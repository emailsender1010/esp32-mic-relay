// Pretends to be the ESP32: connects as the device and streams a 440 Hz
// test tone whenever the relay says "start". Lets you verify the relay and
// the phone page before the sketch is flashed.
import WebSocket from 'ws';

const RELAY =  'ws://127.0.0.1:8080';
const TOKEN = "";

const ws = new WebSocket(`${RELAY}/?role=device&token=${TOKEN}`);
let phase = 0, timer = null;

ws.on('open',  () => console.log('fake device: connected'));
ws.on('close', () => { console.log('fake device: disconnected'); clearInterval(timer); });
ws.on('error', e => console.log('fake device: error', e.message));

ws.on('message', m => {
  const cmd = m.toString();
  console.log('fake device: got', cmd);
  if (cmd === 'start' && !timer) {
    timer = setInterval(() => {
      const buf = Buffer.alloc(512 * 2);
      for (let i = 0; i < 512; i++) {
        buf.writeInt16LE(Math.round(Math.sin(phase) * 8000), i * 2);
        phase += 2 * Math.PI * 440 / 16000;
      }
      ws.send(buf);
    }, 32);
  }
  if (cmd === 'stop' && timer) { clearInterval(timer); timer = null; }
});
