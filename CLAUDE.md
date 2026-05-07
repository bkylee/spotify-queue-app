# Spotify Queue App — Claude Code Context

## What this project is

A web app that lets guests add songs to a host's Spotify queue without needing a Spotify account. Guests access via a 6-character code, search Spotify, and queue songs. The host manages everything via an admin dashboard.

**Live URL:** https://spotify-queue-app.kiyoons.com  
**Admin:** https://spotify-queue-app.kiyoons.com/admin.html  
**Spotify auth:** https://spotify-queue-app.kiyoons.com/auth/login

---

## Project structure

```
/
├── server.js              # Express backend — all API routes
├── public/
│   ├── index.html         # Guest landing page (access code entry)
│   ├── queue.html         # Main guest queue page (after auth)
│   └── admin.html         # Admin dashboard
├── terraform/
│   ├── main.tf            # Azure resources (App Service + Storage)
│   ├── variables.tf       # All Terraform input variables
│   ├── outputs.tf         # Output values after apply
│   └── terraform.tfvars   # Your real values (gitignored)
├── .github/workflows/
│   └── deploy.yml         # GitHub Actions CI/CD (auto-deploy on push to main)
├── deploy.sh              # Manual deploy script (zip deploy to Azure)
├── .env                   # Local env vars (gitignored)
└── .env.example           # Template for env vars
```

---

## Tech stack

- **Runtime:** Node.js 20 LTS
- **Framework:** Express
- **Frontend:** Vanilla JS (no framework)
- **Spotify:** Spotify Web API (search, queue, now playing, profile)
- **Storage:** Azure Table Storage via `@azure/data-tables`
- **Hosting:** Azure App Service (Linux)
- **DNS/Proxy:** Cloudflare
- **IaC:** Terraform
- **CI/CD:** GitHub Actions
- **Key packages:** `axios`, `qrcode`, `dotenv`, `cors`, `@azure/data-tables`

---

## Environment variables

| Variable                          | Description                                   |
| --------------------------------- | --------------------------------------------- |
| `SPOTIFY_CLIENT_ID`               | Spotify app Client ID                         |
| `SPOTIFY_CLIENT_SECRET`           | Spotify app Client Secret                     |
| `REDIRECT_URI`                    | Spotify OAuth redirect (must match dashboard) |
| `SPOTIFY_REFRESH_TOKEN`           | Generated after visiting /auth/login          |
| `ADMIN_PASSWORD`                  | Password for /admin.html                      |
| `HOST_NAME`                       | Host's name shown in guest UI (e.g. "Brian")  |
| `AZURE_STORAGE_CONNECTION_STRING` | Set automatically by Terraform                |
| `PORT`                            | Optional, defaults to 3000                    |

---

## Azure infrastructure

- **App Service:** `spotify-queue-neon-fox` (canadacentral, F1/B1 tier)
- **Resource Group:** `learn-7d094fbd-dd2b-4679-a3a1-20f48cfb12a2`
- **App Service Plan:** `brian.ky.lee_asp_6113` (referenced by full resource ID in Terraform — name contains dots which azurerm provider rejects)
- **Storage Account:** `brianq7x3k`
- **Storage Tables:** `settings`, `blocklist`, `reactions`, `leaderboard`, `activitylog`

---

## Key architecture decisions

### Access control

- 6-char hex codes (`crypto.randomBytes(3).toString('hex').toUpperCase()`)
- Code rotation interval is configurable (default 8h), stored in settings table
- Guest session duration is independently configurable (default 8h), capped by code expiry
- `scheduleCodeRotation()` must be called AFTER `loadSettings()` in `start()` — calling it at module level causes a crash because settings aren't loaded yet

### Persistence

- Settings, blocklist, reactions, leaderboard, activity log → Azure Table Storage
- Guest sessions, access codes, queue history → in-memory only (intentional)
- App gracefully falls back to memory-only if `AZURE_STORAGE_CONNECTION_STRING` is not set

### Reactions

- One reaction per guest per song (stored in `userReactions` object)
- Clicking same emoji toggles off, clicking different emoji switches
- `userReactions` must be declared at top level with other stores — duplicate declaration caused infinite reactions bug
- Uses `data-index` (numeric) not `data-emoji` (emoji char) in HTML attributes to avoid encoding issues

### Host name

- Configured via `HOST_NAME` env var
- Served via `/api/host-name` endpoint
- All three HTML files fetch it dynamically on load

### Terraform quirks

- App Service Plan name has dots → can't use `azurerm_service_plan` resource or data source
- Solution: pass full ARM resource ID as `var.service_plan_id` and use directly in `service_plan_id`
- State files (`terraform.tfstate`, `terraform.tfvars`) are gitignored — never commit them

---

## API routes

### Public

| Method | Route                  | Description                                      |
| ------ | ---------------------- | ------------------------------------------------ |
| GET    | `/api/status`          | Auth status + code expiry                        |
| GET    | `/api/host-name`       | Returns `HOST_NAME` env var                      |
| GET    | `/api/me`              | Spotify profile (name, image)                    |
| GET    | `/api/now-playing`     | Current track + reactions                        |
| GET    | `/api/queue-list`      | Next 15 tracks in queue                          |
| GET    | `/api/queue-history`   | Played tonight (in-memory)                       |
| GET    | `/api/most-requested`  | Leaderboard (top 10)                             |
| GET    | `/api/reaction-stats`  | Reaction totals per song                         |
| GET    | `/api/settings/public` | Guest-facing settings (cooldown, limits, paused) |

### Guest (requires `x-session-id` header)

| Method | Route                | Description                     |
| ------ | -------------------- | ------------------------------- |
| POST   | `/api/access/verify` | Validate code, create session   |
| GET    | `/api/access/check`  | Check if session is still valid |
| GET    | `/api/search`        | Search Spotify catalog          |
| POST   | `/api/queue`         | Add track to Spotify queue      |
| POST   | `/api/react`         | React to now playing track      |

### Admin (requires `x-admin-password` header)

| Method          | Route                       | Description                         |
| --------------- | --------------------------- | ----------------------------------- |
| GET             | `/api/admin/code`           | Current code + QR data URL          |
| POST            | `/api/admin/rotate-code`    | Rotate code, kick all guests        |
| GET             | `/api/admin/guests`         | List active guest sessions          |
| DELETE          | `/api/admin/guests/:id`     | Remove a guest                      |
| GET/PATCH       | `/api/admin/settings`       | Get/update all settings             |
| GET/POST/DELETE | `/api/admin/blocklist`      | Manage blocked tracks/artists       |
| GET             | `/api/admin/activity`       | Activity log (last 100)             |
| GET             | `/api/admin/most-requested` | Top 20 requested tracks             |
| GET             | `/api/admin/search`         | Search Spotify (for blocklist)      |
| DELETE          | `/api/admin/history`        | Clear session data + storage tables |

---

## Deploying code changes

**Automatic (preferred):** push to `main` → GitHub Actions deploys automatically

**Manual fallback:**

```bash
./deploy.sh
```

**Infrastructure changes only:**

```bash
cd terraform
terraform apply -lock=false
```

---

## Common issues & fixes

**App won't start / container timeout**

- Check logs: `az webapp log tail --name spotify-queue-neon-fox --resource-group learn-7d094fbd-dd2b-4679-a3a1-20f48cfb12a2`
- Most likely cause: `scheduleCodeRotation()` called before settings loaded, or missing env var

**Terraform state lock**

```bash
rm terraform/.terraform.tfstate.lock.info
terraform plan -lock=false
```

**Git push rejected (non-fast-forward)**

```bash
git push origin main --force
```

**tfstate committed accidentally**

```bash
git rm --cached terraform/terraform.tfstate terraform/terraform.tfstate.backup
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch --force --index-filter \
  "git rm -rf --cached --ignore-unmatch terraform/terraform.tfstate terraform/terraform.tfstate.backup" \
  --prune-empty --tag-name-filter cat -- --all
git push origin main --force
```

**Admin password stopped working after terraform apply**

- Terraform overwrote app settings with `terraform.tfvars` values
- Check: `cat terraform/terraform.tfvars | grep admin_password`

**Reactions showing Spotify URI instead of song name**

- `nowPlayingCache` wasn't populated yet when reaction was saved
- Fixed in current code — reactions use `nowPlayingCache` as fallback

---

## Settings (all persisted to Azure Table Storage)

| Setting                | Default | Description                         |
| ---------------------- | ------- | ----------------------------------- |
| `maxSongsPerPerson`    | 0       | Max songs per guest (0 = unlimited) |
| `cooldownSeconds`      | 120     | Seconds between requests (0 = none) |
| `queuingPaused`        | false   | Block all new queue requests        |
| `codeRotationHours`    | 8       | How often code auto-rotates (1-24)  |
| `sessionDurationHours` | 8       | Guest session length (1-24)         |
