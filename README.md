# 🎵 Spotify Queue App

A web app that lets guests add songs to your Spotify queue without needing a Spotify account. Features access code control, real-time now playing, reactions, leaderboards, and a full admin dashboard.

## Features

### Guest Experience
- **Access code landing page** — guests enter a 6-character code and their name to gain access
- **Now playing** — live album art, song/artist info, and animated progress bar; album art blurs into a full-screen backdrop with glass morphism cards while music is playing
- **Reaction buttons** — guests react to the current song with 🔥 👍 💀 (one reaction per song, toggle off by clicking again)
- **Up next queue** — shows the next 15 songs with "Queued by [name]" attribution
- **Search** — search Spotify's full catalog to find and queue any track
- **Already queued detection** — songs already in the queue are marked and disabled
- **Blocked track detection** — host-blocked songs are visually marked and cannot be queued
- **Cooldown bar** — visual countdown between song requests when cooldown is enabled
- **History tab** — songs played tonight
- **Reactions tab** — leaderboard of reaction totals per song
- **Session expiry** — countdown showing when access expires, expired overlay with re-entry prompt
- **Light/dark mode** — toggle persisted in `localStorage`, applied before first paint to avoid flash
- **Mobile bottom tab bar** — fixed bottom navigation for Search / History / Reactions on small screens
- **Typography** — Inter (body) + Plus Jakarta Sans (headings)

### Admin Dashboard (`/admin.html`)
- **Password-protected login** — session persists across page refreshes
- **Overview** — access code with expiry bar, QR code for guests, now playing with reaction counts, guests online and songs queued tonight stats
- **QR code** — downloadable QR that opens the app directly
- **Copy code / copy link** — one-click sharing
- **Rotate code** — generates a new code and immediately kicks all guests
- **Queue** — live up-next list with attribution, play/pause/skip playback controls, and add-to-queue search so the admin can queue tracks directly
- **Guests** — live list with join time, songs queued per guest, remove button
- **Settings** — configure songs per person limit (0 = unlimited), cooldown between songs (0 = no cooldown), pause/resume queueing toggle, code rotation interval, guest session duration
- **Blocklist** — search Spotify to block specific tracks or artists; unblock anytime
- **Activity log** — timestamped feed of every join, queue, block, and admin action
- **Stats** — most requested leaderboard with gold/silver/bronze medals, reaction leaderboard per song
- **Auto-refresh** — guests, now playing, and stats all refresh in the background
- **Light/dark mode** — same toggle available on the admin dashboard
- **Mobile-optimized** — settings rows stack vertically, touch targets enlarged, layout adapts to small screens

### Access Control
- 6-character alphanumeric access codes with configurable auto-rotation interval (default 8h, 1–24h range)
- Guest session duration is independently configurable (default 8h, 1–24h range)
- All guest sessions expire when the code rotates
- Admin can rotate the code manually at any time, immediately kicking all guests
- Admin can remove individual guests

### Persistence (Azure Table Storage)
The following data survives app restarts and deployments:
- Settings (songs per person, cooldown, pause state)
- Blocklist
- Reaction history per song
- Most requested leaderboard
- Activity log (last 200 entries)

The following is intentionally in-memory only:
- Guest sessions (short-lived by design)
- Access codes (regenerate on purpose)
- Queue history for the current session

---

## Tech Stack

- **Runtime** — Node.js 22 LTS
- **Backend** — Express
- **Frontend** — Vanilla JS (no framework)
- **Spotify API** — Web API (search, queue, now playing, profile)
- **Storage** — Azure Table Storage (`@azure/data-tables`)
- **Hosting** — Azure App Service (Linux)
- **DNS / Proxy** — Cloudflare
- **Infrastructure** — Terraform (azurerm 4.x)
- **CI/CD** — GitHub Actions (auto-deploys on push to `main`)
- **HTTP** — native `fetch` (Node 22 built-in, no axios)
- **QR codes** — `qrcode` npm package

---

## Getting Started (Local)

### 1. Create a Spotify App

Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), create an app, and note your **Client ID** and **Client Secret**. Add `http://localhost:3000/callback` as a Redirect URI.

### 2. Configure environment

```bash
cp .env.example .env
# Fill in your credentials
```

```env
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
REDIRECT_URI=http://localhost:3000/callback
ADMIN_PASSWORD=your_admin_password
```

### 3. Install and run

```bash
npm install
node server.js
```

### 4. Authorize (one-time)

Visit `http://localhost:3000/auth/login`, log in with your Spotify account, and copy the refresh token into your `.env` as `SPOTIFY_REFRESH_TOKEN`. Restart the server.

### 5. Share with guests

Give guests `http://localhost:3000` (or use [ngrok](https://ngrok.com) for a public URL).

---

## Deploying to Azure

### Prerequisites
- [Azure CLI](https://docs.microsoft.com/en-us/cli/azure/install-azure-cli)
- [Terraform](https://developer.hashicorp.com/terraform/install)

### 1. Configure Terraform variables

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
# Fill in your credentials and a unique storage account name
```

### 2. Deploy infrastructure

```bash
az login
terraform init
terraform plan -lock=false
terraform apply -lock=false
```

This creates the Azure App Service and Azure Table Storage account with all required tables, and injects the storage connection string into the app automatically.

### 3. Authorize Spotify

Visit `https://your-app.azurewebsites.net/auth/login`, log in, copy the refresh token and add it to Azure:

```bash
az webapp config appsettings set \
  --name your-app-name \
  --resource-group your-resource-group \
  --settings SPOTIFY_REFRESH_TOKEN="your_token"
```

### 4. Deploy code

Push to `main` — GitHub Actions deploys automatically.

---

## Code Deploys

**Automatic (preferred):** push to `main` — GitHub Actions builds and deploys automatically.

**Infrastructure changes** (Node version, env vars, scaling):

```bash
cd terraform
terraform apply -lock=false
```

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SPOTIFY_CLIENT_ID` | From your Spotify app dashboard |
| `SPOTIFY_CLIENT_SECRET` | From your Spotify app dashboard |
| `REDIRECT_URI` | Must match exactly what's set in Spotify dashboard |
| `SPOTIFY_REFRESH_TOKEN` | Generated after running `/auth/login` |
| `ADMIN_PASSWORD` | Password for `/admin.html` — **required**, app won't start without it |
| `HOST_NAME` | Host's name shown in guest UI (e.g. `Brian` → "Update Brian's Queue") |
| `AZURE_STORAGE_CONNECTION_STRING` | Set automatically by Terraform |
| `PORT` | Optional, defaults to 3000 |

---

## URLs

| URL | Description |
|-----|-------------|
| `/` | Guest landing page (access code entry) |
| `/queue.html` | Main guest queue page |
| `/admin.html` | Admin dashboard |
| `/auth/login` | Spotify authorization (host only, one-time) |

---

## Notes

- Spotify must be **actively playing** on a device for guests to queue songs
- On the F1 free tier, the app may cold-start after ~20 min of inactivity — open it yourself before guests arrive
- The refresh token persists across restarts — re-authorization is only needed if Spotify scopes change
- `terraform.tfvars`, `terraform.tfstate`, and `terraform.tfstate.*.backup` are gitignored — never commit them as they contain secrets
- If Azure App Service settings are overwritten unexpectedly after a `terraform apply`, check `terraform.tfvars` for stale values

## License

MIT
