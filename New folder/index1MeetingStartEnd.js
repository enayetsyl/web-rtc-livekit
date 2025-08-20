import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json());

const HOST  = process.env.LIVEKIT_HOST;     // e.g. https://amplify-xxxx.livekit.cloud  (HTTPS)
const WS_URL = process.env.LIVEKIT_WS_URL;  // e.g. wss://amplify-xxxx.livekit.cloud    (WSS)
const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;

if (!HOST || !WS_URL || !API_KEY || !API_SECRET) {
  console.error('Missing envs. Set LIVEKIT_HOST, LIVEKIT_WS_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET');
  process.exit(1);
}

const rooms = new RoomServiceClient(HOST, API_KEY, API_SECRET);

// NOTE: toJwt() is async in v2 — must await
async function tokenFor({ room, identity, admin = false }) {
  const at = new AccessToken(API_KEY, API_SECRET, { identity /*, ttl: '2h' */ });
  at.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
    roomAdmin: admin,
  });
  return await at.toJwt(); // <-- important
}

// health
app.get('/health', (_, res) => res.json({ ok: true }));

// start meeting: (optionally) create room + host token
app.post('/api/meeting/start', async (req, res) => {
  const { roomName, username } = req.body || {};
  if (!roomName || !username) return res.status(400).json({ error: 'roomName and username required' });
  try { await rooms.createRoom({ name: roomName, emptyTimeout: 60 * 60 }); } catch (_) {}
  const token = await tokenFor({ room: roomName, identity: username, admin: true }); // <-- await
  res.json({ roomName, token, wsUrl: WS_URL });
});

// join meeting: participant token
app.post('/api/meeting/join', async (req, res) => {
  const { roomName, username } = req.body || {};
  if (!roomName || !username) return res.status(400).json({ error: 'roomName and username required' });
  try {
    // Option A: cheap and reliable for all SDK versions
    const existing = await rooms.listRooms();              // RoomServiceClient
    const found = existing.find(r => r.name === roomName);
    if (!found) {
      return res.status(404).json({ error: 'Room not started yet. Ask the host to Start meeting.' });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Failed to check rooms' });
  }

  const token = await tokenFor({ room: roomName, identity: username });
  res.json({ roomName, token, wsUrl: WS_URL });
});

// end meeting: delete room (disconnects everyone)
app.post('/api/meeting/end', async (req, res) => {
  const { roomName } = req.body || {};
  if (!roomName) return res.status(400).json({ error: 'roomName required' });
  await rooms.deleteRoom(roomName);
  res.json({ ok: true });
});

app.listen(process.env.PORT || 3001, () =>
  console.log(`LiveKit backend on :${process.env.PORT || 3001}`),
);
