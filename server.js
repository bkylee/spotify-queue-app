require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { TableClient, AzureNamedKeyCredential } = require('@azure/data-tables');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/callback';
if (!process.env.ADMIN_PASSWORD) {
  console.error('FATAL: ADMIN_PASSWORD env var is required');
  process.exit(1);
}
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const HOST_NAME = process.env.HOST_NAME || 'Your Host';
const STORAGE_CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;

// ─── Azure Table Storage ─────────────────────────────────────────────

function getTableClient(tableName) {
  if (!STORAGE_CONN) return null;
  return TableClient.fromConnectionString(STORAGE_CONN, tableName);
}

async function tableGet(tableName, partitionKey, rowKey) {
  try {
    const client = getTableClient(tableName);
    if (!client) return null;
    const entity = await client.getEntity(partitionKey, rowKey);
    return entity;
  } catch (e) {
    if (e.statusCode === 404) return null;
    console.error(`tableGet ${tableName} error:`, e.message);
    return null;
  }
}

async function tableUpsert(tableName, entity) {
  try {
    const client = getTableClient(tableName);
    if (!client) return;
    await client.upsertEntity(entity, 'Replace');
  } catch (e) {
    console.error(`tableUpsert ${tableName} error:`, e.message);
  }
}

async function tableDelete(tableName, partitionKey, rowKey) {
  try {
    const client = getTableClient(tableName);
    if (!client) return;
    await client.deleteEntity(partitionKey, rowKey);
  } catch (e) {
    if (e.statusCode !== 404) console.error(`tableDelete ${tableName} error:`, e.message);
  }
}

async function tableList(tableName, partitionKey) {
  try {
    const client = getTableClient(tableName);
    if (!client) return [];
    const filter = partitionKey ? `PartitionKey eq '${partitionKey}'` : undefined;
    const entities = [];
    for await (const entity of client.listEntities({ queryOptions: { filter } })) {
      entities.push(entity);
    }
    return entities;
  } catch (e) {
    console.error(`tableList ${tableName} error:`, e.message);
    return [];
  }
}

// ─── Settings (admin-editable, persisted) ────────────────────────────

let settings = {
  maxSongsPerPerson: 0,
  cooldownSeconds: 120,
  queuingPaused: false,
  codeRotationHours: 8,
  sessionDurationHours: 8,
};

async function loadSettings() {
  const entity = await tableGet('settings', 'settings', 'main');
  if (entity) {
    settings.maxSongsPerPerson = entity.maxSongsPerPerson ?? 0;
    settings.cooldownSeconds = entity.cooldownSeconds ?? 120;
    settings.queuingPaused = entity.queuingPaused ?? false;
    settings.codeRotationHours = entity.codeRotationHours ?? 8;
    settings.sessionDurationHours = entity.sessionDurationHours ?? 8;
    console.log('✅ Settings loaded from Table Storage');
    // Reschedule rotation if loaded value differs from default
    scheduleCodeRotation();
  }
}

async function saveSettings() {
  await tableUpsert('settings', {
    partitionKey: 'settings',
    rowKey: 'main',
    maxSongsPerPerson: settings.maxSongsPerPerson,
    cooldownSeconds: settings.cooldownSeconds,
    queuingPaused: settings.queuingPaused,
    codeRotationHours: settings.codeRotationHours,
    sessionDurationHours: settings.sessionDurationHours,
  });
}

// ─── Blocklist (persisted) ────────────────────────────────────────────

let blocklist = [];

async function loadBlocklist() {
  const entities = await tableList('blocklist', 'block');
  blocklist = entities.map(e => ({ type: e.type, id: e.rowKey, uri: e.uri || '', name: e.name }));
  if (blocklist.length) console.log(`✅ Blocklist loaded: ${blocklist.length} items`);
}

async function saveBlocklistItem(item) {
  await tableUpsert('blocklist', {
    partitionKey: 'block',
    rowKey: item.id,
    type: item.type,
    uri: item.uri || '',
    name: item.name,
  });
}

async function deleteBlocklistItem(id) {
  await tableDelete('blocklist', 'block', id);
}

function safeKey(uri) {
  return uri.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 100);
}

// ─── Reaction history (persisted) ────────────────────────────────────

let reactionHistory = {};

async function loadReactionHistory() {
  const entities = await tableList('reactions', 'reaction');
  entities.forEach(e => {
    reactionHistory[e.rowKey] = {
      uri: e.rowKey,
      name: e.name || '',
      artist: e.artist || '',
      image: e.image || null,
      '🔥': e.fire || 0,
      '👍': e.thumbsup || 0,
      '💀': e.skull || 0,
      total: e.total || 0,
    };
  });
  if (entities.length) console.log(`✅ Reaction history loaded: ${entities.length} tracks`);
}

async function saveReactionEntry(uri) {
  const r = reactionHistory[uri];
  if (!r) return;
  const safeRowKey = safeKey(uri);
  await tableUpsert('reactions', {
    partitionKey: 'reaction',
    rowKey: safeRowKey,
    originalUri: uri,
    name: r.name,
    artist: r.artist,
    image: r.image || '',
    fire: r['🔥'] || 0,
    thumbsup: r['👍'] || 0,
    skull: r['💀'] || 0,
    total: r.total || 0,
  });
}

// ─── Leaderboard (persisted) ──────────────────────────────────────────

let mostRequested = {};

async function loadLeaderboard() {
  const entities = await tableList('leaderboard', 'track');
  entities.forEach(e => {
    mostRequested[e.rowKey] = {
      uri: e.rowKey,
      name: e.name || '',
      artist: e.artist || '',
      image: e.image || null,
      count: e.count || 0,
    };
  });
  if (entities.length) console.log(`✅ Leaderboard loaded: ${entities.length} tracks`);
}

async function saveLeaderboardEntry(uri) {
  const t = mostRequested[uri];
  if (!t) return;
  const safeRowKey = safeKey(uri);
  await tableUpsert('leaderboard', {
    partitionKey: 'track',
    rowKey: safeRowKey,
    originalUri: uri,
    name: t.name,
    artist: t.artist,
    image: t.image || '',
    count: t.count,
  });
}

// ─── Activity log (persisted, last 200) ──────────────────────────────

let activityLog = [];

async function loadActivityLog() {
  const entities = await tableList('activitylog', 'log');
  activityLog = entities
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 200)
    .map(e => ({ ts: e.ts, guestName: e.guestName, action: e.action, trackName: e.trackName || '', artist: e.artist || '' }));
  if (activityLog.length) console.log(`✅ Activity log loaded: ${activityLog.length} entries`);
}

async function saveActivityEntry(entry) {
  await tableUpsert('activitylog', {
    partitionKey: 'log',
    rowKey: String(entry.ts) + '_' + crypto.randomBytes(3).toString('hex'),
    ts: entry.ts,
    guestName: entry.guestName,
    action: entry.action,
    trackName: entry.trackName || '',
    artist: entry.artist || '',
  });
}

// ─── In-memory only stores ────────────────────────────────────────────

let tokenStore = {
  access_token: null,
  refresh_token: process.env.SPOTIFY_REFRESH_TOKEN || null,
  expires_at: 0,
};

let accessCode = generateNewCode();
let guestSessions = {};
let queuedThisSession = {};
let userReactions = {};
let reactions = {};
let currentTrackUri = null;
let lastPlayingUri = null;
let queueHistory = [];
let nowPlayingCache = null;

const EMOJIS = ['🔥', '👍', '💀'];

function getCodeValidityMs() {
  return settings.codeRotationHours * 60 * 60 * 1000;
}

function getSessionDurationMs() {
  return settings.sessionDurationHours * 60 * 60 * 1000;
}

function generateNewCode() {
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();
  const now = Date.now();
  return { code, createdAt: now, expiresAt: now + getCodeValidityMs() };
}

let rotationTimer = null;

function scheduleCodeRotation() {
  if (rotationTimer) clearInterval(rotationTimer);
  rotationTimer = setInterval(() => {
    accessCode = generateNewCode();
    guestSessions = {};
    queuedThisSession = {};
    userReactions = {};
    console.log(`🔄 Access code rotated: ${accessCode.code}`);
  }, getCodeValidityMs());
}

function isValidSession(sessionId) {
  const session = guestSessions[sessionId];
  if (!session) return false;
  if (Date.now() > session.expiresAt) { delete guestSessions[sessionId]; return false; }
  return true;
}

// ─── Spotify token management ─────────────────────────────────────────

async function refreshAccessToken() {
  if (!tokenStore.refresh_token) throw new Error('No refresh token.');
  const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokenStore.refresh_token });
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
    },
    body: params.toString(),
  });
  if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`);
  const data = await response.json();
  tokenStore.access_token = data.access_token;
  tokenStore.expires_at = Date.now() + data.expires_in * 1000 - 60000;
  if (data.refresh_token) tokenStore.refresh_token = data.refresh_token;
  return tokenStore.access_token;
}

async function getAccessToken() {
  if (tokenStore.access_token && Date.now() < tokenStore.expires_at) return tokenStore.access_token;
  return refreshAccessToken();
}

// ─── Background: track change detection ──────────────────────────────

setInterval(async () => {
  try {
    const token = await getAccessToken();
    const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 204) { nowPlayingCache = null; return; }
    if (!res.ok) return;
    const resData = await res.json();
    if (!resData?.item) { nowPlayingCache = null; return; }
    const t = resData.item;
    const uri = t.uri;
    nowPlayingCache = {
      playing: resData.is_playing, uri,
      name: t.name, artist: t.artists.map(a => a.name).join(', '),
      album: t.album.name,
      image: t.album.images?.[1]?.url || t.album.images?.[0]?.url || null,
      progress_ms: resData.progress_ms, duration_ms: t.duration_ms,
    };
    if (uri !== lastPlayingUri) {
      if (lastPlayingUri) {
        queueHistory.unshift({
          uri: lastPlayingUri,
          name: t.name,
          artist: t.artists.map(a => a.name).join(', '),
          image: t.album.images?.[2]?.url || null,
          playedAt: Date.now(),
        });
        if (queueHistory.length > 50) queueHistory.pop();
      }
      reactions[uri] = { '🔥': 0, '👍': 0, '💀': 0 };
      currentTrackUri = uri;
      lastPlayingUri = uri;
    } else if (!reactions[uri]) {
      reactions[uri] = { '🔥': 0, '👍': 0, '💀': 0 };
    }
  } catch {}
}, 8000);

// ─── Logging ──────────────────────────────────────────────────────────

async function logActivity(guestName, action, trackName = '', artist = '') {
  const entry = { ts: Date.now(), guestName, action, trackName, artist };
  activityLog.unshift(entry);
  if (activityLog.length > 200) activityLog.pop();
  await saveActivityEntry(entry);
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

// ─── Spotify auth ─────────────────────────────────────────────────────

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
  if (!code) return res.status(400).send('No auth code.');
  try {
    const params = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      },
      body: params.toString(),
    });
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error_description || `Auth failed: ${response.status}`);
    }
    const tokenData = await response.json();
    tokenStore.access_token = tokenData.access_token;
    tokenStore.refresh_token = tokenData.refresh_token;
    tokenStore.expires_at = Date.now() + tokenData.expires_in * 1000 - 60000;
    res.send(`<html><body style="font-family:sans-serif;padding:2rem;background:#0f0f0f;color:#fff">
      <h2>✅ Authorized!</h2>
      <p style="font-size:12px;color:#888">Save as SPOTIFY_REFRESH_TOKEN:</p>
      <code style="background:#222;padding:8px;display:block;border-radius:6px;word-break:break-all">${tokenData.refresh_token}</code>
      <p><a href="/" style="color:#1db954">Go to app →</a></p>
    </body></html>`);
  } catch (err) {
    res.status(500).send('Auth failed: ' + err.message);
  }
});

// ─── Spotify helpers ──────────────────────────────────────────────────

async function spotifySearchTracks(q, limit = 8) {
  const token = await getAccessToken();
  const url = new URL('https://api.spotify.com/v1/search');
  url.searchParams.set('q', q);
  url.searchParams.set('type', 'track');
  url.searchParams.set('limit', String(limit));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('Search failed');
  const data = await res.json();
  return data.tracks.items;
}

function recordQueuedTrack(uri, name, artist, image, queuedBy) {
  queuedThisSession[uri] = { name, artist, queuedBy, queuedAt: Date.now() };
  if (!mostRequested[uri]) mostRequested[uri] = { uri, name, artist, image, count: 0 };
  mostRequested[uri].count++;
  saveLeaderboardEntry(uri);
  logActivity(queuedBy, 'queued', name, artist);
}

// ─── Guest access ─────────────────────────────────────────────────────

app.post('/api/access/verify', (req, res) => {
  const { code, name } = req.body;
  if (!code || !name?.trim()) return res.status(400).json({ error: 'Code and name are required.' });
  if (code.trim().toUpperCase() !== accessCode.code) {
    return res.status(401).json({ error: 'Invalid access code. Check with your host.' });
  }
  const sessionId = crypto.randomBytes(16).toString('hex');
  const sessionExpiry = Math.min(accessCode.expiresAt, Date.now() + getSessionDurationMs());
  guestSessions[sessionId] = { name: name.trim(), grantedAt: Date.now(), expiresAt: sessionExpiry, songsQueued: 0, lastQueuedAt: 0, sessionId };
  logActivity(name.trim(), 'joined');
  res.json({ sessionId, expiresAt: sessionExpiry, name: name.trim() });
});

app.get('/api/access/check', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId || !isValidSession(sessionId)) return res.json({ valid: false });
  const session = guestSessions[sessionId];
  res.json({ valid: true, name: session.name, expiresAt: session.expiresAt });
});

// ─── Public API ───────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  res.json({ authorized: !!(tokenStore.access_token || tokenStore.refresh_token), codeExpiresAt: accessCode.expiresAt });
});

app.get('/api/host-name', (req, res) => {
  res.json({ hostName: HOST_NAME });
});

app.get('/api/me', async (req, res) => {
  try {
    const token = await getAccessToken();
    const response = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error('Profile fetch failed');
    const { display_name, images } = await response.json();
    res.json({ name: display_name, image: images?.[0]?.url || null });
  } catch { res.status(500).json({ error: 'Could not fetch profile' }); }
});

app.get('/api/now-playing', (req, res) => {
  if (!nowPlayingCache) return res.json({ playing: false });
  res.json({ ...nowPlayingCache, reactions: reactions[nowPlayingCache.uri] || {} });
});

app.get('/api/queue-list', async (req, res) => {
  try {
    const token = await getAccessToken();
    const response = await fetch('https://api.spotify.com/v1/me/player/queue', { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error('Queue fetch failed');
    const queueData = await response.json();
    const tracks = (queueData.queue || []).slice(0, 15).map(t => {
      const meta = queuedThisSession[t.uri] || {};
      return {
        uri: t.uri, name: t.name,
        artist: t.artists.map(a => a.name).join(', '),
        image: t.album.images?.[2]?.url || t.album.images?.[1]?.url || null,
        duration_ms: t.duration_ms,
        queuedBy: meta.queuedBy || null,
      };
    });
    res.json({ tracks });
  } catch { res.status(500).json({ error: 'Could not fetch queue' }); }
});

app.get('/api/queue-history', (req, res) => res.json({ history: queueHistory.slice(0, 20) }));

app.get('/api/most-requested', (req, res) => {
  const sorted = Object.values(mostRequested).sort((a, b) => b.count - a.count).slice(0, 10);
  res.json({ tracks: sorted });
});

app.get('/api/reaction-stats', (req, res) => {
  const sorted = Object.values(reactionHistory)
    .filter(r => r.total > 0)
    .sort((a, b) => (b.total || 0) - (a.total || 0))
    .slice(0, 20);
  res.json({ stats: sorted });
});

app.get('/api/settings/public', (req, res) => {
  res.json({ maxSongsPerPerson: settings.maxSongsPerPerson, cooldownSeconds: settings.cooldownSeconds, queuingPaused: settings.queuingPaused });
});

// ─── Protected: search ────────────────────────────────────────────────

app.get('/api/search', requireGuest, async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.json({ tracks: [] });
  try {
    const items = await spotifySearchTracks(q);
    const tracks = items.map(t => {
      const isBlocked = blocklist.some(b =>
        (b.type === 'track' && b.id === t.id) ||
        (b.type === 'artist' && t.artists.some(a => a.id === b.id))
      );
      return {
        id: t.id, uri: t.uri, name: t.name,
        artist: t.artists.map(a => a.name).join(', '),
        artistIds: t.artists.map(a => a.id),
        album: t.album.name,
        image: t.album.images?.[1]?.url || t.album.images?.[0]?.url || null,
        duration_ms: t.duration_ms,
        alreadyQueued: !!queuedThisSession[t.uri],
        blocked: isBlocked,
      };
    });
    res.json({ tracks });
  } catch { res.status(500).json({ error: 'Search failed' }); }
});

// ─── Protected: queue a track ─────────────────────────────────────────

app.post('/api/queue', requireGuest, async (req, res) => {
  const { uri, name, artist, image } = req.body;
  if (!uri) return res.status(400).json({ error: 'Missing track URI' });

  const sessionId = req.headers['x-session-id'];
  const session = guestSessions[sessionId];

  if (settings.queuingPaused) return res.status(403).json({ error: 'Queueing is paused by the host.' });

  const isBlocked = blocklist.some(b => b.type === 'track' && b.uri === uri);
  if (isBlocked) return res.status(403).json({ error: 'This track has been blocked by the host.' });

  if (settings.maxSongsPerPerson > 0 && session.songsQueued >= settings.maxSongsPerPerson) {
    return res.status(403).json({ error: `You've reached the limit of ${settings.maxSongsPerPerson} song${settings.maxSongsPerPerson !== 1 ? 's' : ''}.` });
  }

  if (settings.cooldownSeconds > 0 && session.lastQueuedAt) {
    const elapsed = Date.now() - session.lastQueuedAt;
    const cooldownMs = settings.cooldownSeconds * 1000;
    if (elapsed < cooldownMs) {
      const remaining = Math.ceil((cooldownMs - elapsed) / 1000);
      return res.status(429).json({ error: `Please wait ${remaining}s before queuing another song.`, remainingSeconds: remaining });
    }
  }

  try {
    const token = await getAccessToken();
    const queueRes = await fetch(
      `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(uri)}`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
    );
    if (!queueRes.ok) {
      const errData = await queueRes.json().catch(() => ({}));
      const err = new Error(errData.error?.message || 'Queue request failed');
      err.status = queueRes.status;
      throw err;
    }

    session.songsQueued++;
    session.lastQueuedAt = Date.now();
    recordQueuedTrack(uri, name, artist, image, session.name);
    res.json({ success: true });
  } catch (err) {
    const status = err.status || 500;
    const msg = err.message;
    if (status === 404) res.status(404).json({ error: 'No active Spotify device found.' });
    else res.status(status).json({ error: msg });
  }
});

// ─── Protected: react ─────────────────────────────────────────────────

app.post('/api/react', requireGuest, (req, res) => {
  const { uri, emojiIndex } = req.body;
  const emoji = EMOJIS[emojiIndex];
  const sessionId = req.headers['x-session-id'];
  if (!uri || !emoji) return res.status(400).json({ error: 'Invalid reaction' });

  if (!reactions[uri]) reactions[uri] = { '🔥': 0, '👍': 0, '💀': 0 };
  if (!userReactions[sessionId]) userReactions[sessionId] = {};

  const prevIndex = userReactions[sessionId][uri];
  const prevEmoji = EMOJIS[prevIndex];

  if (prevIndex === emojiIndex) {
    reactions[uri][emoji] = Math.max(0, (reactions[uri][emoji] || 0) - 1);
    delete userReactions[sessionId][uri];
    if (reactionHistory[uri]) {
      reactionHistory[uri][emoji] = Math.max(0, (reactionHistory[uri][emoji] || 0) - 1);
      reactionHistory[uri].total = Math.max(0, (reactionHistory[uri].total || 0) - 1);
      saveReactionEntry(uri);
    }
    return res.json({ reactions: reactions[uri], myReaction: null });
  }

  if (prevEmoji && prevIndex !== emojiIndex) {
    reactions[uri][prevEmoji] = Math.max(0, (reactions[uri][prevEmoji] || 0) - 1);
    if (reactionHistory[uri]) {
      reactionHistory[uri][prevEmoji] = Math.max(0, (reactionHistory[uri][prevEmoji] || 0) - 1);
      reactionHistory[uri].total = Math.max(0, (reactionHistory[uri].total || 0) - 1);
    }
  }

  reactions[uri][emoji]++;
  userReactions[sessionId][uri] = emojiIndex;

  const trackMeta = queuedThisSession[uri] || mostRequested[uri];
  const nowPlayingMeta = (currentTrackUri === uri && nowPlayingCache) ? nowPlayingCache : null;
  const trackName = trackMeta?.name || nowPlayingMeta?.name || '';
  const artist = trackMeta?.artist || nowPlayingMeta?.artist || '';
  const image = trackMeta?.image || nowPlayingMeta?.image || null;

  if (!reactionHistory[uri]) reactionHistory[uri] = { uri, name: trackName, artist, image, '🔥': 0, '👍': 0, '💀': 0, total: 0 };
  if (!reactionHistory[uri].name && trackName) {
    reactionHistory[uri].name = trackName;
    reactionHistory[uri].artist = artist;
    reactionHistory[uri].image = image;
  }

  reactionHistory[uri][emoji]++;
  reactionHistory[uri].total = (reactionHistory[uri].total || 0) + 1;
  saveReactionEntry(uri);

  res.json({ reactions: reactions[uri], myReaction: emojiIndex });
});

// ─── Admin API ────────────────────────────────────────────────────────

app.get('/api/admin/code', requireAdmin, async (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const qrDataUrl = await QRCode.toDataURL(baseUrl, { width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
  res.json({ code: accessCode.code, createdAt: accessCode.createdAt, expiresAt: accessCode.expiresAt, qrDataUrl, appUrl: baseUrl });
});

app.post('/api/admin/rotate-code', requireAdmin, (req, res) => {
  accessCode = generateNewCode();
  guestSessions = {};
  queuedThisSession = {};
  logActivity('Admin', 'rotated access code');
  res.json({ code: accessCode.code, expiresAt: accessCode.expiresAt });
});

app.get('/api/admin/guests', requireAdmin, (req, res) => {
  const guests = Object.values(guestSessions).map(s => ({
    sessionId: s.sessionId, name: s.name, grantedAt: s.grantedAt,
    expiresAt: s.expiresAt, songsQueued: s.songsQueued, lastQueuedAt: s.lastQueuedAt,
  }));
  res.json({ guests });
});

app.delete('/api/admin/guests/:sessionId', requireAdmin, (req, res) => {
  const { sessionId } = req.params;
  if (!guestSessions[sessionId]) return res.status(404).json({ error: 'Guest not found' });
  const name = guestSessions[sessionId].name;
  delete guestSessions[sessionId];
  logActivity('Admin', 'removed guest', name);
  res.json({ success: true });
});

app.get('/api/admin/settings', requireAdmin, (req, res) => res.json(settings));

app.patch('/api/admin/settings', requireAdmin, async (req, res) => {
  const { maxSongsPerPerson, cooldownSeconds, queuingPaused, codeRotationHours, sessionDurationHours } = req.body;
  if (maxSongsPerPerson !== undefined) settings.maxSongsPerPerson = Math.max(0, parseInt(maxSongsPerPerson) || 0);
  if (cooldownSeconds !== undefined) settings.cooldownSeconds = Math.max(0, parseInt(cooldownSeconds) || 0);
  if (queuingPaused !== undefined) settings.queuingPaused = !!queuingPaused;
  if (codeRotationHours !== undefined) {
    settings.codeRotationHours = Math.max(1, Math.min(24, parseInt(codeRotationHours) || 8));
    scheduleCodeRotation(); // restart timer with new interval
  }
  if (sessionDurationHours !== undefined) {
    settings.sessionDurationHours = Math.max(1, Math.min(24, parseInt(sessionDurationHours) || 8));
  }
  await saveSettings();
  logActivity('Admin', 'updated settings');
  res.json(settings);
});

app.get('/api/admin/blocklist', requireAdmin, (req, res) => res.json({ blocklist }));

app.post('/api/admin/blocklist', requireAdmin, async (req, res) => {
  const { type, id, uri, name } = req.body;
  if (!type || !id || !name) return res.status(400).json({ error: 'Missing fields' });
  if (!blocklist.find(b => b.id === id)) {
    const item = { type, id, uri: uri || '', name };
    blocklist.push(item);
    await saveBlocklistItem(item);
    logActivity('Admin', 'blocked', name);
  }
  res.json({ blocklist });
});

app.delete('/api/admin/blocklist/:id', requireAdmin, async (req, res) => {
  blocklist = blocklist.filter(b => b.id !== req.params.id);
  await deleteBlocklistItem(req.params.id);
  res.json({ blocklist });
});

app.get('/api/admin/activity', requireAdmin, (req, res) => res.json({ log: activityLog.slice(0, 100) }));

app.get('/api/admin/most-requested', requireAdmin, (req, res) => {
  const sorted = Object.values(mostRequested).sort((a, b) => b.count - a.count).slice(0, 20);
  res.json({ tracks: sorted });
});

app.delete('/api/admin/history', requireAdmin, async (req, res) => {
  queueHistory = [];
  mostRequested = {};
  queuedThisSession = {};
  reactionHistory = {};
  // Clear persisted tables
  try {
    const lbClient = getTableClient('leaderboard');
    const rxClient = getTableClient('reactions');
    if (lbClient) for await (const e of lbClient.listEntities()) await lbClient.deleteEntity(e.partitionKey, e.rowKey).catch(() => {});
    if (rxClient) for await (const e of rxClient.listEntities()) await rxClient.deleteEntity(e.partitionKey, e.rowKey).catch(() => {});
  } catch (e) { console.error('Clear history error:', e.message); }
  logActivity('Admin', 'cleared session data');
  res.json({ success: true });
});

app.get('/api/admin/search', requireAdmin, async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ tracks: [] });
  try {
    const items = await spotifySearchTracks(q);
    const tracks = items.map(t => ({
      id: t.id, uri: t.uri, name: t.name,
      artist: t.artists.map(a => a.name).join(', '),
      artistIds: t.artists.map(a => a.id),
      image: t.album.images?.[1]?.url || t.album.images?.[0]?.url || null,
    }));
    res.json({ tracks });
  } catch { res.status(500).json({ error: 'Search failed' }); }
});

// ─── Admin: player controls & queue ──────────────────────────────────

app.post('/api/admin/player/skip', requireAdmin, async (req, res) => {
  try {
    const token = await getAccessToken();
    const response = await fetch('https://api.spotify.com/v1/me/player/next', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json({ success: response.ok || response.status === 204 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/player/pause', requireAdmin, async (req, res) => {
  try {
    const token = await getAccessToken();
    await fetch('https://api.spotify.com/v1/me/player/pause', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/player/play', requireAdmin, async (req, res) => {
  try {
    const token = await getAccessToken();
    await fetch('https://api.spotify.com/v1/me/player/play', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/queue', requireAdmin, async (req, res) => {
  const { uri, name, artist, image } = req.body;
  if (!uri) return res.status(400).json({ error: 'Missing track URI' });
  try {
    const token = await getAccessToken();
    const queueRes = await fetch(
      `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(uri)}`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
    );
    if (!queueRes.ok) {
      const errData = await queueRes.json().catch(() => ({}));
      return res.status(queueRes.status).json({ error: errData.error?.message || 'Queue failed' });
    }
    if (name) recordQueuedTrack(uri, name, artist || '', image || null, 'Admin');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

async function start() {
  if (STORAGE_CONN) {
    console.log('📦 Loading data from Azure Table Storage...');
    await Promise.all([
      loadSettings(),
      loadBlocklist(),
      loadReactionHistory(),
      loadLeaderboard(),
      loadActivityLog(),
    ]);
  } else {
    console.log('⚠️  AZURE_STORAGE_CONNECTION_STRING not set — running in memory-only mode');
  }

  // Start code rotation after settings are loaded
  scheduleCodeRotation();

  app.listen(PORT, () => {
    console.log(`\n🎵 Spotify Queue App running at http://localhost:${PORT}`);
    console.log(`🔑 Access code: ${accessCode.code}`);
    console.log(`🔒 Admin: http://localhost:${PORT}/admin.html`);
    if (!tokenStore.refresh_token) console.log(`⚠️  Visit http://localhost:${PORT}/auth/login to authorize.`);
  });
}

start();