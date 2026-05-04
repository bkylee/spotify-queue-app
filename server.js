require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");
const rateLimit = require("express-rate-limit");

const app = express();
app.use(
  cors({
    origin: "https://myapp.azurewebsites.net",
  }),
);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI =
  process.env.REDIRECT_URI || "http://localhost:3000/callback";

// In-memory token store (use a file/DB for persistence across restarts)
let tokenStore = {
  access_token: process.env.SPOTIFY_ACCESS_TOKEN || null,
  refresh_token: process.env.SPOTIFY_REFRESH_TOKEN || null,
  expires_at: 0,
};

// ─── Token management ────────────────────────────────────────────────

async function refreshAccessToken() {
  if (!tokenStore.refresh_token)
    throw new Error("No refresh token stored. Please authorize first.");

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokenStore.refresh_token,
  });

  const response = await axios.post(
    "https://accounts.spotify.com/api/token",
    params.toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization:
          "Basic " +
          Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
      },
    },
  );

  tokenStore.access_token = response.data.access_token;
  tokenStore.expires_at = Date.now() + response.data.expires_in * 1000 - 60000;
  if (response.data.refresh_token) {
    tokenStore.refresh_token = response.data.refresh_token;
  }
  return tokenStore.access_token;
}

async function getAccessToken() {
  if (tokenStore.access_token && Date.now() < tokenStore.expires_at) {
    return tokenStore.access_token;
  }
  return refreshAccessToken();
}

// ─── Auth routes (host only) ─────────────────────────────────────────

app.get("/auth/login", (req, res) => {
  const scopes =
    "user-modify-playback-state user-read-playback-state user-read-currently-playing";
  const url = new URL("https://accounts.spotify.com/authorize");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", scopes);
  res.redirect(url.toString());
});

app.get("/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("No auth code received.");

  try {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
    });

    const response = await axios.post(
      "https://accounts.spotify.com/api/token",
      params.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization:
            "Basic " +
            Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
        },
      },
    );

    tokenStore.access_token = response.data.access_token;
    tokenStore.refresh_token = response.data.refresh_token;
    tokenStore.expires_at =
      Date.now() + response.data.expires_in * 1000 - 60000;

    console.log("\n✅ Authorization successful!");
    console.log(
      "💾 Save this refresh token to your .env as SPOTIFY_REFRESH_TOKEN:",
    );
    console.log(tokenStore.refresh_token);

    res.send(`
      <html><body style="font-family:sans-serif;padding:2rem;background:#0f0f0f;color:#fff">
        <h2>✅ Authorized!</h2>
        <p>Your Spotify account is connected. You can close this tab.</p>
        <p style="font-size:12px;color:#888">Save this to your .env file as SPOTIFY_REFRESH_TOKEN to persist across restarts:</p>
        <code style="background:#222;padding:8px;display:block;border-radius:6px;word-break:break-all">${tokenStore.refresh_token}</code>
        <p><a href="/" style="color:#1db954">Go to the queue app →</a></p>
      </body></html>
    `);
  } catch (err) {
    console.error("Auth error:", err.response?.data || err.message);
    res
      .status(500)
      .send(
        "Authorization failed: " +
          (err.response?.data?.error_description || err.message),
      );
  }
});

// ─── API routes (used by guest frontend) ────────────────────────────

app.get("/api/status", async (req, res) => {
  const isReady = !!(tokenStore.access_token || tokenStore.refresh_token);
  res.json({ authorized: isReady });
});

app.get("/api/search", async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.json({ tracks: [] });

  try {
    const token = await getAccessToken();
    const response = await axios.get("https://api.spotify.com/v1/search", {
      headers: { Authorization: `Bearer ${token}` },
      params: { q, type: "track", limit: 8 },
    });

    const tracks = response.data.tracks.items.map((t) => ({
      id: t.id,
      uri: t.uri,
      name: t.name,
      artist: t.artists.map((a) => a.name).join(", "),
      album: t.album.name,
      image: t.album.images?.[1]?.url || t.album.images?.[0]?.url || null,
      duration_ms: t.duration_ms,
    }));

    res.json({ tracks });
  } catch (err) {
    console.error("Search error:", err.response?.data || err.message);
    res.status(500).json({ error: "Search failed" });
  }
});

app.get("/api/me", async (req, res) => {
  try {
    const token = await getAccessToken();
    const response = await axios.get("https://api.spotify.com/v1/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { display_name, images } = response.data;
    res.json({
      name: display_name,
      image: images?.[0]?.url || null,
    });
  } catch (err) {
    console.error("Profile error:", err.response?.data || err.message);
    res.status(500).json({ error: "Could not fetch profile" });
  }
});

app.get("/api/now-playing", async (req, res) => {
  try {
    const token = await getAccessToken();
    const response = await axios.get(
      "https://api.spotify.com/v1/me/player/currently-playing",
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    if (response.status === 204 || !response.data || !response.data.item) {
      return res.json({ playing: false });
    }

    const t = response.data.item;
    res.json({
      playing: response.data.is_playing,
      name: t.name,
      artist: t.artists.map((a) => a.name).join(", "),
      album: t.album.name,
      image: t.album.images?.[1]?.url || t.album.images?.[0]?.url || null,
      progress_ms: response.data.progress_ms,
      duration_ms: t.duration_ms,
    });
  } catch (err) {
    console.error("Now playing error:", err.response?.data || err.message);
    res.status(500).json({ error: "Could not fetch now playing" });
  }
});

app.get("/api/queue-list", async (req, res) => {
  try {
    const token = await getAccessToken();
    const response = await axios.get(
      "https://api.spotify.com/v1/me/player/queue",
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    const tracks = (response.data.queue || []).slice(0, 10).map((t) => ({
      name: t.name,
      artist: t.artists.map((a) => a.name).join(", "),
      image: t.album.images?.[2]?.url || t.album.images?.[1]?.url || null,
      duration_ms: t.duration_ms,
    }));

    res.json({ tracks });
  } catch (err) {
    console.error("Queue list error:", err.response?.data || err.message);
    res.status(500).json({ error: "Could not fetch queue" });
  }
});

app.post("/api/queue", async (req, res) => {
  const { uri } = req.body;
  if (!uri) return res.status(400).json({ error: "Missing track URI" });

  try {
    const token = await getAccessToken();
    await axios.post(
      `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(uri)}`,
      {},
      { headers: { Authorization: `Bearer ${token}` } },
    );
    res.json({ success: true });
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    const status = err.response?.status || 500;
    console.error("Queue error:", msg);

    if (status === 404) {
      res.status(404).json({
        error:
          "No active Spotify device found. Make sure Spotify is open and playing.",
      });
    } else {
      res.status(status).json({ error: msg });
    }
  }
});

// ─── Start ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🎵 Spotify Queue App running at http://localhost:${PORT}`);
  if (!tokenStore.refresh_token) {
    console.log(
      `\n⚠️  Not yet authorized. Visit http://localhost:${PORT}/auth/login to connect your Spotify account.`,
    );
  } else {
    console.log(`✅ Spotify token loaded. Guests can queue songs!`);
  }
});

const addSongLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 3, // 3 requests per 10 minutes per IP
  message: { error: "Too many song requests. Try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});
