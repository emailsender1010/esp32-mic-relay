# esp32-mic-relay

Live microphone audio from an ESP32-S3 desk display to a phone browser, from
anywhere, with no port forwarding and nothing running at home. Both ends dial
out to this relay, so CGNAT on your home connection never matters.

```
ESP32  --wss-->  relay (Render)  <--wss--  phone browser
```

Audio is raw 16 kHz mono 16-bit PCM in binary WebSocket frames. Everything
else is a short text/JSON control message.

## Deploy to Render

1. Push these four files (`package.json`, `server.js`, `listen.html`,
   `render.yaml`) to a GitHub repo.
2. Render Dashboard → **New** → **Web Service** → connect the repo.
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `node server.js`
   - Instance type: **Free**
3. Deploy. Render assigns a URL like `https://esp32-mic-relay.onrender.com`.
4. Open **Environment** on the service and copy the two generated values:
   - `DEVICE_TOKEN` → paste into the sketch as `RELAY_DEVICE_TOKEN`
   - `LISTEN_TOKEN` → type into the phone page once; it's remembered locally

   If you created the service manually instead of via `render.yaml`, add both
   variables yourself. Use long random strings — anything that can open your
   room mic deserves a real password. The server refuses to start without them.

5. Set `RELAY_HOST` in the sketch to your Render hostname (no `https://`,
   no trailing slash) and flash it.

## Using it

Open `https://<your-service>.onrender.com` on your phone, paste the listen
token, tap **Start listening**.

The bars are driven by the actual samples arriving, so they're also the
"is this really working" indicator: moving bars means audio is flowing.

## Free tier behaviour

Free Render services spin down after 15 minutes without traffic and take about
a minute to wake. Two ways to deal with it:

- **Keep it warm (default).** The sketch sends a keepalive message every
  4 minutes, which counts as traffic and prevents spindown. Listening is
  then instant. Costs roughly 744 instance hours/month against the 750
  free hours, so this should be your only free service.
- **Let it sleep.** Set `RELAY_KEEPALIVE_MS` to `0` in the sketch. Opening
  the phone page wakes the service (~1 min), then the ESP32 reconnects
  within its 5 second retry interval and the page flips to "Desk display
  ready" on its own. Costs almost no instance hours.

## Data

16 kHz × 16-bit ≈ 256 kbps ≈ **115 MB per hour**, counted on your mobile data
and on the relay's outbound bandwidth. Fine for checking in; expensive if you
leave it running. µ-law encoding would halve it with no audible difference on
speech.

## Safety notes

- The listen token is the key to your room. Treat it that way, and rotate it
  in Render's Environment tab if you ever paste it somewhere careless.
- When the last listener disconnects, the relay tells the device to stop, so
  a phone that loses signal can't leave the mic open.
- The device has a local override: the **Remote Listen** card in the desk
  display's own web portal. Switch it off and the device refuses start
  commands regardless of who holds the token.
- Whenever audio is actually leaving the device, its RGB LED goes solid red
  and the screen reads LIVE MIC.
