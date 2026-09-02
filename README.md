# NextUp

A shared YouTube queue for the living room. One phone is the speaker. Everyone else searches, pastes links, and **votes** on what plays next.

No accounts. No npm. No server to run — only a static file host. Works across WiFi and cellular.

## Use it

Live: **https://raman20.github.io/nextup/**

Open that URL on the host phone. Create a room, keep the tab visible, tap **Start the party**. Friends open the same site (WiFi or LTE), type the code or scan the QR.

Local preview (YouTube blocks `file://` embeds):

```bash
cd nextup
node serve.mjs
```

Then `http://localhost:8080`. GitHub Pages is the origin you want for a real hangout.

## How it works

- **Host device** loads the official YouTube IFrame player. That is the only speaker.
- **Queue + votes** sync over a public MQTT WebSocket broker (HiveMQ, Mosquitto fallback). We do not operate that broker. App data is a JSON snapshot on `nextup/{code}/…`.
- **Search** (optional): host pastes a YouTube Data API v3 key in ⚙. The key stays in that phone’s `localStorage`. Guests send queries to the host; the host calls Google. Default quota is tight (~100 searches/day), so results are cached. **Paste a YouTube URL always works**, with no key.

## YouTube rules we follow

Official IFrame only. The player stays visible (≥ 200×200), ads and YouTube chrome stay, no audio extraction. By using NextUp you also agree to [YouTube’s Terms of Service](https://www.youtube.com/t/terms).

The host phone must keep the tab in the foreground. iOS will stop playback if you switch apps — that is Safari + YouTube, not NextUp.

## API key (optional)

1. Google Cloud → enable **YouTube Data API v3** → create an API key.
2. Restrict it to HTTP referers for this origin (`https://raman20.github.io/*`).
3. Host: ⚙ → paste key → Save.

## Swap the message bus

Public brokers have no SLA. Edit `BROKERS` at the top of `js/net.js`.

## Tests

`http://localhost:8080/test.html`

## Limits

- Anyone who knows the room code can join and vote.
- Symmetric NAT is irrelevant here (no WebRTC). You need internet for YouTube and the broker.
- This is a hangout tool, not a product with uptime.
