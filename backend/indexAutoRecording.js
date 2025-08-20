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

const HOST   = process.env.LIVEKIT_HOST;  // https://<proj>.livekit.cloud  (HTTPS)
const WS_URL = process.env.LIVEKIT_WS_URL; // wss://<proj>.livekit.cloud   (WSS)
const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;

if (!HOST || !WS_URL || !API_KEY || !API_SECRET) {
  console.error('Missing envs. Set LIVEKIT_HOST, LIVEKIT_WS_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET');
  process.exit(1);
}

const rooms  = new RoomServiceClient(HOST, API_KEY, API_SECRET);
const egress = new EgressClient(HOST, API_KEY, API_SECRET);

// Track active recording(s) per room so we can stop them on end
const activeEgressByRoom = new Map(); // roomName -> Set<egressId>

// ---- token helper (v2 toJwt is async) ----
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

// ---- health ----
app.get('/health', (_, res) => res.json({ ok: true }));

// ---- START MEETING: create room, start recording to S3, return host token ----
app.post('/api/meeting/start', async (req, res) => {
  const { roomName, username } = req.body || {};
  if (!roomName || !username) return res.status(400).json({ error: 'roomName and username required' });

  // 1) ensure room exists
  try { await rooms.createRoom({ name: roomName, emptyTimeout: 60 * 60 }); } catch (_) {}

  // 2) start room-composite egress to S3 (auto-record)
  let egressInfo = null;
  try {
    const fileOutput = new EncodedFileOutput({
      filepath: `{room_name}-{time}.mp4`,
      output: {
        case: 's3',
        value: new S3Upload({
          accessKey: process.env.S3_ACCESS_KEY,
          secret: process.env.S3_SECRET,
          bucket: process.env.S3_BUCKET,
          region: process.env.S3_REGION,
          endpoint: process.env.S3_ENDPOINT || undefined,
          forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true' || undefined,
        }),
      },
    });

    // modern signature: output + opts (layout, encoding, etc.)
    egressInfo = await egress.startRoomCompositeEgress(
      roomName,
      fileOutput,
      { layout: 'grid' } // try 'speaker', 'single-speaker', 'grid-light' too
    ); // returns EgressInfo with egressId
    if (!activeEgressByRoom.has(roomName)) activeEgressByRoom.set(roomName, new Set());
    activeEgressByRoom.get(roomName).add(egressInfo.egressId);
  } catch (err) {
    console.error('Auto-record start error:', err?.message || err);
    // don’t block the meeting if recording fails
  }

  // 3) mint host token
  const token = await tokenFor({ room: roomName, identity: username, admin: true });
  res.json({
    roomName,
    token,
    wsUrl: WS_URL,
    recording: Boolean(egressInfo?.egressId),
    egressId: egressInfo?.egressId || null,
  });
});

// ---- JOIN MEETING: only if room exists (no auto-create) ----
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

// ---- END MEETING: stop recording(s), then delete room ----
app.post('/api/meeting/end', async (req, res) => {
  const { roomName } = req.body || {};
  if (!roomName) return res.status(400).json({ error: 'roomName required' });

  // stop egress first (optional but ensures clean finalize)
  const ids = activeEgressByRoom.get(roomName);
  if (ids && ids.size) {
    for (const id of ids) {
      try { await egress.stopEgress(id); } catch (e) { console.warn('stopEgress error', id, e?.message || e); }
    }
    activeEgressByRoom.delete(roomName);
  }

  await rooms.deleteRoom(roomName); // boots everyone
  res.json({ ok: true });
});

app.listen(process.env.PORT || 3001, () =>
  console.log(`LiveKit backend on :${process.env.PORT || 3001}`),
);
