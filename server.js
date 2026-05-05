require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/callback';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const CODE_VALIDITY_MS = 8 * 60 * 60 * 1000; // 8 hours

// ─── In-memory stores ────────────────────────────────────────────────

let tokenStore = {
  access_token: process.env.SPOTIFY_ACCESS_TOKEN || null,
  refresh_token: process.env.SPOTIFY_REFRESH_TOKEN || null,
  expires_at: 0,
};

// Access code store: { code, createdAt, expiresAt }
let accessCode = generateNewCode();

// Guest sessions: { [sessionId]: { name, grantedAt, expiresAt, songsQueued } }
let guestSessions = {};

// ─── Access code management ──────────────────────────────────────────

function generateNewCode() {
  const code = crypto.randomBytes(3).toString('hex').toUpperCase(); // e.g. "A3F9B2"
  const now = Date.now();
  return { code, createdAt: now, expiresAt: now + CODE_VALIDITY_MS };
}

// Auto-refresh access code every 8 hours
setInterval(() => {
  accessCode = generateNewCode();
  // Expire all existing guest sessions when code rotates
  guestSessions = {};
  console.log(`🔄 Access code rotated: ${accessCode.code}`);
}, CODE_VALIDITY_MS);

function isValidSession(sessionId) {
  const session = guestSessions[sessionId];
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    delete guestSessions[sessionId];
    return false;
  }
  return true;
}

// ─── Spotify token management ────────────────────────────────────────

async function refreshAccessToken() {
  if (!tokenStore.refresh_token) throw new Error('No refresh token. Please authorize first.');
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokenStore.refresh_token,
  });
  const response = await axios.post('https://accounts.spotify.com/api/token', params.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
    },
  });
  tokenStore.access_token = response.data.access_token;
  tokenStore.expires_at = Date.now() + response.data.expires_in * 1000 - 60000;
  if (response.data.refresh_token) tokenStore.refresh_token = response.data.refresh_token;
  return tokenStore.access_token;
}

async function getAccessToken() {
  if (tokenStore.access_token && Date.now() < tokenStore.expires_at) return tokenStore.access_token;
  return refreshAccessToken();
}

// ─── Middleware ───────────────────────────────────────────────────────

function requireGuest(req, res, next) {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId || !isValidSession(sessionId)) {
    return res.status(401).json({ error: 'Access denied. Please enter the access code.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  const auth = req.headers['x-admin-password'];
  if (auth !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Invalid admin password' });
  next();
}

// ─── Spotify auth routes ─────────────────────────────────────────────

app.get('/auth/login', (req, res) => {
  const scopes = 'user-modify-playback-state user-read-playback-state user-read-currently-playing user-read-private user-read-email';
  const url = new URL('https://accounts.spotify.com/authorize');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', scopes);
  res.redirect(url.toString());
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No auth code received.');
  try {
    const params = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
    const response = await axios.post('https://accounts.spotify.com/api/token', params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      },
    });
    tokenStore.access_token = response.data.access_token;
    tokenStore.refresh_token = response.data.refresh_token;
    tokenStore.expires_at = Date.now() + response.data.expires_in * 1000 - 60000;
    console.log('\n✅ Authorization successful! Refresh token:', tokenStore.refresh_token);
    res.send(`<html><body style="font-family:sans-serif;padding:2rem;background:#0f0f0f;color:#fff">
      <h2>✅ Authorized!</h2>
      <p>Your Spotify account is connected.</p>
      <p style="font-size:12px;color:#888">Save this as SPOTIFY_REFRESH_TOKEN in your .env:</p>
      <code style="background:#222;padding:8px;display:block;border-radius:6px;word-break:break-all">${tokenStore.refresh_token}</code>
      <p><a href="/" style="color:#1db954">Go to the queue app →</a></p>
    </body></html>`);
  } catch (err) {
    res.status(500).send('Authorization failed: ' + (err.response?.data?.error_description || err.message));
  }
});

// ─── Guest access routes ─────────────────────────────────────────────

// Validate access code and create a session
app.post('/api/access/verify', (req, res) => {
  const { code, name } = req.body;
  if (!code || !name || !name.trim()) return res.status(400).json({ error: 'Code and name are required.' });

  if (code.trim().toUpperCase() !== accessCode.code) {
    return res.status(401).json({ error: 'Invalid access code. Check with your host.' });
  }

  const sessionId = crypto.randomBytes(16).toString('hex');
  guestSessions[sessionId] = {
    name: name.trim(),
    grantedAt: Date.now(),
    expiresAt: accessCode.expiresAt,
    songsQueued: 0,
    sessionId,
  };

  console.log(`✅ Guest "${name.trim()}" granted access`);
  res.json({ sessionId, expiresAt: accessCode.expiresAt, name: name.trim() });
});

// Check if a session is still valid
app.get('/api/access/check', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId || !isValidSession(sessionId)) {
    return res.json({ valid: false });
  }
  const session = guestSessions[sessionId];
  res.json({ valid: true, name: session.name, expiresAt: session.expiresAt });
});

// ─── Public API (no auth needed) ─────────────────────────────────────

app.get('/api/status', (req, res) => {
  const isReady = !!(tokenStore.access_token || tokenStore.refresh_token);
  res.json({ authorized: isReady, codeExpiresAt: accessCode.expiresAt });
});

app.get('/api/me', async (req, res) => {
  try {
    const token = await getAccessToken();
    const response = await axios.get('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${token}` } });
    const { display_name, images } = response.data;
    res.json({ name: display_name, image: images?.[0]?.url || null });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch profile' });
  }
});

app.get('/api/now-playing', async (req, res) => {
  try {
    const token = await getAccessToken();
    const response = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 204 || !response.data?.item) return res.json({ playing: false });
    const t = response.data.item;
    res.json({
      playing: response.data.is_playing,
      name: t.name,
      artist: t.artists.map(a => a.name).join(', '),
      album: t.album.name,
      image: t.album.images?.[1]?.url || t.album.images?.[0]?.url || null,
      progress_ms: response.data.progress_ms,
      duration_ms: t.duration_ms,
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch now playing' });
  }
});

app.get('/api/queue-list', async (req, res) => {
  try {
    const token = await getAccessToken();
    const response = await axios.get('https://api.spotify.com/v1/me/player/queue', { headers: { Authorization: `Bearer ${token}` } });
    const tracks = (response.data.queue || []).slice(0, 10).map(t => ({
      name: t.name,
      artist: t.artists.map(a => a.name).join(', '),
      image: t.album.images?.[2]?.url || t.album.images?.[1]?.url || null,
      duration_ms: t.duration_ms,
    }));
    res.json({ tracks });
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch queue' });
  }
});

// ─── Protected API (guest session required) ───────────────────────────

app.get('/api/search', requireGuest, async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.json({ tracks: [] });
  try {
    const token = await getAccessToken();
    const response = await axios.get('https://api.spotify.com/v1/search', {
      headers: { Authorization: `Bearer ${token}` },
      params: { q, type: 'track', limit: 8 },
    });
    const tracks = response.data.tracks.items.map(t => ({
      id: t.id, uri: t.uri, name: t.name,
      artist: t.artists.map(a => a.name).join(', '),
      album: t.album.name,
      image: t.album.images?.[1]?.url || t.album.images?.[0]?.url || null,
      duration_ms: t.duration_ms,
    }));
    res.json({ tracks });
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});

app.post('/api/queue', requireGuest, async (req, res) => {
  const { uri } = req.body;
  if (!uri) return res.status(400).json({ error: 'Missing track URI' });
  try {
    const token = await getAccessToken();
    await axios.post(
      `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(uri)}`,
      {},
      { headers: { Authorization: `Bearer ${token}` } }
    );
    // Track songs queued per guest
    const sessionId = req.headers['x-session-id'];
    if (guestSessions[sessionId]) guestSessions[sessionId].songsQueued++;
    res.json({ success: true });
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    const status = err.response?.status || 500;
    if (status === 404) {
      res.status(404).json({ error: 'No active Spotify device found. Make sure Spotify is open and playing.' });
    } else {
      res.status(status).json({ error: msg });
    }
  }
});

// ─── Admin API ────────────────────────────────────────────────────────

app.get('/api/admin/code', requireAdmin, async (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const qrDataUrl = await QRCode.toDataURL(baseUrl, { width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
  res.json({
    code: accessCode.code,
    createdAt: accessCode.createdAt,
    expiresAt: accessCode.expiresAt,
    qrDataUrl,
    appUrl: baseUrl,
  });
});

app.post('/api/admin/rotate-code', requireAdmin, (req, res) => {
  accessCode = generateNewCode();
  guestSessions = {};
  console.log(`🔄 Access code manually rotated: ${accessCode.code}`);
  res.json({ code: accessCode.code, expiresAt: accessCode.expiresAt });
});

app.get('/api/admin/guests', requireAdmin, (req, res) => {
  const guests = Object.values(guestSessions).map(s => ({
    sessionId: s.sessionId,
    name: s.name,
    grantedAt: s.grantedAt,
    expiresAt: s.expiresAt,
    songsQueued: s.songsQueued,
  }));
  res.json({ guests });
});

app.delete('/api/admin/guests/:sessionId', requireAdmin, (req, res) => {
  const { sessionId } = req.params;
  if (!guestSessions[sessionId]) return res.status(404).json({ error: 'Guest not found' });
  const name = guestSessions[sessionId].name;
  delete guestSessions[sessionId];
  console.log(`🚫 Guest "${name}" removed by admin`);
  res.json({ success: true });
});

// ─── Start ────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🎵 Spotify Queue App running at http://localhost:${PORT}`);
  console.log(`🔑 Current access code: ${accessCode.code} (expires in 8 hours)`);
  console.log(`🔒 Admin page: http://localhost:${PORT}/admin.html`);
  if (!tokenStore.refresh_token) {
    console.log(`⚠️  Not yet authorized. Visit http://localhost:${PORT}/auth/login`);
  }
});
