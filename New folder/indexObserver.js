import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import {
  AccessToken,
  RoomServiceClient,
  EgressClient,
  SegmentedFileOutput,
  S3Upload,
} from 'livekit-server-sdk';

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json());

const HOST   = process.env.LIVEKIT_HOST;   // https://<proj>.livekit.cloud
const WS_URL = process.env.LIVEKIT_WS_URL; // wss://<proj>.livekit.cloud
const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;

// HLS CDN (CloudFront or similar) and S3 path prefix for segments
const HLS_PUBLIC_BASE = process.env.HLS_PUBLIC_BASE; // e.g. https://cdn.example.com
const HLS_PREFIX = process.env.HLS_PREFIX || 'hls';  // folder prefix in your bucket

if (!HOST || !WS_URL || !API_KEY || !API_SECRET) {
  console.error('Missing envs. Set LIVEKIT_HOST, LIVEKIT_WS_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET');
  process.exit(1);
}

const rooms  = new RoomServiceClient(HOST, API_KEY, API_SECRET);
const egress = new EgressClient(HOST, API_KEY, API_SECRET);

// Track active HLS egress per room so we can stop on End
const activeEgressByRoom = new Map(); // roomName -> Set<egressId>

// ---------- roles & grants ----------
const ROLES = ['admin', 'moderator', 'participant', 'observer'];
const isAdminish = (role) => role === 'admin' || role === 'moderator';

function ensureRole(role) {
  if (!role || !ROLES.includes(role)) {
    const err = new Error(`Invalid or missing role. Allowed: ${ROLES.join(', ')}`);
    err.status = 400; throw err;
  }
}
function ensureAdminish(role) {
  if (!isAdminish(role)) {
    const err = new Error('Forbidden: only admin/moderator allowed');
    err.status = 403; throw err;
  }
}

function grantFor(role, room) {
  const g = { roomJoin: true, room, canSubscribe: true };
  if (role === 'observer') {
    g.canPublish = false;
    g.canPublishData = false;
    // If you *do* let observers connect, you can hide them:
    // g.hidden = true;
  } else {
    g.canPublish = true;
    g.canPublishData = true;
  }
  if (isAdminish(role)) g.roomAdmin = true;
  return g;
}

async function mintToken({ room, identity, role }) {
  const at = new AccessToken(API_KEY, API_SECRET, {
    identity,
    metadata: JSON.stringify({ role }),
  });
  at.addGrant(grantFor(role, room));
  return await at.toJwt();
}

// ---------- HLS helpers ----------
function hlsPaths(roomName) {
  const dir = `${HLS_PREFIX}/${encodeURIComponent(roomName)}`;

  return {
    filenamePrefix: `${dir}/segment`,
    playlistName: 'index.m3u8',
    livePlaylistName: 'live.m3u8',
    liveUrl: HLS_PUBLIC_BASE ? `${HLS_PUBLIC_BASE}/${dir}/live.m3u8` : null,
    vodUrl:  HLS_PUBLIC_BASE ? `${HLS_PUBLIC_BASE}/${dir}/index.m3u8` : null,
   };
}

async function startHlsEgress(roomName) {
  const { filenamePrefix, playlistName, livePlaylistName } = hlsPaths(roomName);

  const segments = new SegmentedFileOutput({
    // defaults to HLS; we set names + short segments (2s) for low latency
    filenamePrefix,
    playlistName,
    livePlaylistName,
    segmentDuration: 2,
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

  // Start Room Composite with HLS (segments). This supports “live playlist” + VOD on S3. :contentReference[oaicite:1]{index=1}
  const info = await egress.startRoomCompositeEgress(
    roomName,
    { segments },                         // EncodedOutputs.segments
    { layout: 'grid' }                    // pick 'speaker' / 'single-speaker' / 'grid-light' if you prefer
  );

  if (!activeEgressByRoom.has(roomName)) activeEgressByRoom.set(roomName, new Set());
  activeEgressByRoom.get(roomName).add(info.egressId);

  return info;
}

async function stopAllEgress(roomName) {
  const ids = activeEgressByRoom.get(roomName);
  if (ids && ids.size) {
    for (const id of ids) {
      try { await egress.stopEgress(id); } catch (e) { console.warn('stopEgress error', id, e?.message || e); }
    }
    activeEgressByRoom.delete(roomName);
  }
}

// ---------- routes ----------
app.get('/health', (_, res) => res.json({ ok: true }));

// START (admin/moderator only): create room, auto-start HLS, return token + HLS URLs
app.post('/api/meeting/start', async (req, res) => {
  try {
    const { roomName, username, role } = req.body || {};
    if (!roomName || !username) return res.status(400).json({ error: 'roomName and username required' });
    ensureRole(role); ensureAdminish(role);

    // ensure room exists
    try { await rooms.createRoom({ name: roomName, emptyTimeout: 60 * 60 }); } catch (_) {}

    // auto-start HLS egress (record + live)
    let egressInfo = null;
    try { egressInfo = await startHlsEgress(roomName); }
    catch (e) { console.error('HLS start error:', e?.message || e); /* don’t block meeting */ }

    const token = await mintToken({ room: roomName, identity: username, role });
    const { liveUrl, vodUrl } = hlsPaths(roomName);

    res.json({
      roomName, role, token, wsUrl: WS_URL,
      hls: { liveUrl, vodUrl },
      egressId: egressInfo?.egressId || null,
    });
  } catch (e) {
    res.status(e?.status || 500).json({ error: e?.message || 'Failed to start meeting' });
  }
});

// JOIN (any role): participants get a token; observers just get HLS URLs (no need to connect)
app.post('/api/meeting/join', async (req, res) => {
  try {
    const { roomName, username, role = 'participant' } = req.body || {};
    if (!roomName || !username) return res.status(400).json({ error: 'roomName and username required' });
    ensureRole(role);

    const existing = await rooms.listRooms();
    const found = existing.find(r => r.name === roomName);
    if (!found) return res.status(404).json({ error: 'Room not started yet. Ask the host to Start meeting.' });

    const { liveUrl, vodUrl } = hlsPaths(roomName);

    if (role === 'observer') {
      // Observers don’t need a token or to connect; they’ll play HLS.
      return res.json({ roomName, role, hls: { liveUrl, vodUrl } });
    }

    const token = await mintToken({ room: roomName, identity: username, role });
    res.json({ roomName, role, token, wsUrl: WS_URL, hls: { liveUrl, vodUrl } });
  } catch (e) {
    res.status(e?.status || 500).json({ error: e?.message || 'Failed to join meeting' });
  }
});

// END (admin/moderator only): stop HLS then delete room
app.post('/api/meeting/end', async (req, res) => {
  try {
    const { roomName, role } = req.body || {};
    if (!roomName) return res.status(400).json({ error: 'roomName required' });
    ensureRole(role); ensureAdminish(role);

    await stopAllEgress(roomName);
    await rooms.deleteRoom(roomName);
    res.json({ ok: true });
  } catch (e) {
    res.status(e?.status || 500).json({ error: e?.message || 'Failed to end meeting' });
  }
});

app.listen(process.env.PORT || 3001, () =>
  console.log(`LiveKit backend on :${process.env.PORT || 3001}`),
);
