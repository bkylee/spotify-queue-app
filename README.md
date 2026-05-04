# Spotify Queue App

Let guests add songs to your Spotify queue — no Spotify account needed.

## Setup (5 minutes)

### 1. Create a Spotify App

1. Go to https://developer.spotify.com/dashboard
2. Click **Create App**
3. Set **Redirect URI** to `http://localhost:3000/callback` (or your deployed URL + `/callback`)
4. Note your **Client ID** and **Client Secret**

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env and fill in your Client ID and Client Secret
```

### 3. Install and run

```bash
npm install
node server.js
```

### 4. Authorize your Spotify account (one-time)

1. Open http://localhost:3000/auth/login in your browser
2. Log in with **your** Spotify account
3. Copy the refresh token shown and paste it into `.env` as `SPOTIFY_REFRESH_TOKEN`
4. Restart the server — you'll never need to re-authorize

### 5. Share with guests

Give guests your URL (e.g. `http://your-ip:3000` or a tunneled URL via ngrok). They can search and queue songs instantly — no login needed.

## Deployment tips

- **ngrok**: `ngrok http 3000` gives you a public URL instantly. Update `REDIRECT_URI` and your Spotify app's redirect URI accordingly.
- **Railway / Render / Fly.io**: Deploy for free, set env vars in the dashboard.
- **Important**: Make sure Spotify is actively playing on a device, otherwise queueing will return a 404.

## How it works

```
Guest → searches → /api/search → Spotify Search API
Guest → clicks add → /api/queue → Spotify Add to Queue API (using your token)
Your token is refreshed automatically in the background
```
