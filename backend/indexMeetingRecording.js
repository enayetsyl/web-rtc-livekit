import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import {
  AccessToken,
  RoomServiceClient,
  EgressClient,
  EncodedFileOutput,
  S3Upload,
} from 'livekit-server-sdk';

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json());

const HOST   = process.env.LIVEKIT_HOST;     // https://<proj>.livekit.cloud
const WS_URL = process.env.LIVEKIT_WS_URL;   // wss://<proj>.livekit.cloud
const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;

if (!HOST || !WS_URL || !API_KEY || !API_SECRET) {
  console.error('Missing envs. Set LIVEKIT_HOST, LIVEKIT_WS_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET');
  process.exit(1);
}

const rooms  = new RoomServiceClient(HOST, API_KEY, API_SECRET);
const egress = new EgressClient(HOST, API_KEY, API_SECRET);

// track active recordings so we can stop them gracefully
const activeEgressByRoom = new Map(); // roomName -> Set<egressId>

// ---------------- token helper ----------------
async function tokenFor({ room, identity, admin = false }) {
  const at = new AccessToken(API_KEY, API_SECRET, { identity });
  at.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
    roomAdmin: admin,
  });
  return await at.toJwt();
}

// ---------------- health ----------------
app.get('/health', (_, res) => res.json({ ok: true }));

// ---------------- meetings ----------------
app.post('/api/meeting/start', async (req, res) => {
  const { roomName, username } = req.body || {};
  if (!roomName || !username) return res.status(400).json({ error: 'roomName and username required' });
  try { await rooms.createRoom({ name: roomName, emptyTimeout: 60 * 60 }); } catch (_) {}
  const token = await tokenFor({ room: roomName, identity: username, admin: true });
  res.json({ roomName, token, wsUrl: WS_URL });
});

app.post('/api/meeting/join', async (req, res) => {
  const { roomName, username } = req.body || {};
  if (!roomName || !username) return res.status(400).json({ error: 'roomName and username required' });
  try {
    const existing = await rooms.listRooms();
    const found = existing.find(r => r.name === roomName);
    if (!found) return res.status(404).json({ error: 'Room not started yet. Ask the host to Start meeting.' });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to check rooms' });
  }
  const token = await tokenFor({ room: roomName, identity: username });
  res.json({ roomName, token, wsUrl: WS_URL });
});

// End meeting: stop recording (if any) then delete room
app.post('/api/meeting/end', async (req, res) => {
  const { roomName } = req.body || {};
  if (!roomName) return res.status(400).json({ error: 'roomName required' });

  // stop any active egress first (optional; room deletion would also stop it)
  const ids = activeEgressByRoom.get(roomName);
  if (ids && ids.size) {
    for (const id of ids) {
      try { await egress.stopEgress(id); } catch (_) {}
    }
    activeEgressByRoom.delete(roomName);
  }

  await rooms.deleteRoom(roomName);
  res.json({ ok: true });
});

// ---------------- recording (Egress) ----------------
// Start recording the room as MP4 to S3
app.post('/api/record/start', async (req, res) => {
  const { roomName, layout = 'grid', filename = '{room_name}-{time}.mp4' } = req.body || {};
  if (!roomName) return res.status(400).json({ error: 'roomName required' });

  try {
    const file = new EncodedFileOutput({
      filepath: filename,                       // default templating ok
      // fileType: EncodedFileType.MP4,         // optional; MP4 is default
      output: {
        case: 's3',
        value: new S3Upload({
          accessKey: process.env.S3_ACCESS_KEY,
          secret: process.env.S3_SECRET,
          bucket: process.env.S3_BUCKET,
          region: process.env.S3_REGION,
          endpoint: process.env.S3_ENDPOINT || undefined,            // optional for S3-compat
          forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true' // optional for S3-compat
        }),
      },
    });

    // ✅ correct signature: 2nd arg is an object with { file }
    const info = await egress.startRoomCompositeEgress(
      roomName,
      { file },                  // <-- this was the bug
      { layout }                 // 'grid' | 'speaker' | 'single-speaker' | 'grid-light'
    );

    res.json({ ok: true, egressId: info.egressId, status: info.status });
  } catch (e) {
    console.error('egress start error:', e?.message || e);
    // surface a helpful message while keeping details in server logs
    res.status(500).json({ error: e?.message || 'Failed to start recording' });
  }
});

// Stop by egressId
app.post('/api/record/stop', async (req, res) => {
  const { egressId, roomName } = req.body || {};
  if (!egressId) return res.status(400).json({ error: 'egressId required' });
  try {
    const info = await egress.stopEgress(egressId);
    if (roomName && activeEgressByRoom.has(roomName)) {
      activeEgressByRoom.get(roomName).delete(egressId);
      if (!activeEgressByRoom.get(roomName).size) activeEgressByRoom.delete(roomName);
    }
    res.json({ ok: true, status: info.status });
  } catch (e) {
    console.error('egress stop error', e);
    res.status(500).json({ error: 'Failed to stop recording' });
  }
});

app.listen(process.env.PORT || 3001, () =>
  console.log(`LiveKit backend on :${process.env.PORT || 3001}`),
);
