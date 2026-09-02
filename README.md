# NextUp

A shared YouTube **playlist** for the living room. One phone is the speaker. Everyone else adds and bumps tracks. The queue **is** a YouTube playlist; we poll it (etag) so phones stay in sync.

No MQTT. No npm. Official YouTube IFrame on the host. Google account for writes.

Live: **https://raman20.github.io/nextup/**

## Setup (once)

1. [Google Cloud Console](https://console.cloud.google.com/) → enable **YouTube Data API v3**.
2. Credentials → **OAuth 2.0 Client ID** → type **Web application**.
3. Authorized JavaScript origins:
   - `https://raman20.github.io`
   - `http://localhost:8080`
4. Put the client ID in `js/config.js` (`GOOGLE_CLIENT_ID`) and deploy, **or** paste it in the home-screen setup box (that phone only).

OAuth consent screen: add yourself as a test user while the app is in Testing.

## Party

1. Host: Sign in with Google → **Create playlist room**. Keep that tab open.
2. Share the QR / link (`#/p/PLxxxx`).
3. On YouTube, open the playlist → **Collaborate** → allow adds → send friends the invite once (YouTube only lets the **owner or collaborators** call `playlistItems.insert`).
4. Friends: Sign in with Google → paste links or search → ▲ / ▼ to move songs.
5. Host taps **Start the party**.

Local preview: `node serve.mjs` → `http://localhost:8080`.

## How refresh works

YouTube playlists do not push. NextUp polls `playlistItems.list` every few seconds (If-None-Match / etag). New adds, skips, and bumps show up on every signed-in phone. The host player follows item **#1** as now playing; skip **deletes** that playlist item and plays the next.

## Limits

- Collaborators are a YouTube product feature, not a Data API invite. If add returns 403, enable Collaborate on the playlist.
- Search uses the same Cloud project quota (`search.list` is expensive). Paste-a-link is cheap.
- Host tab must stay in the foreground (Safari/iOS will stop the embed).
- Playlist is unlisted, not a bank vault.

[YouTube Terms of Service](https://www.youtube.com/t/terms)
