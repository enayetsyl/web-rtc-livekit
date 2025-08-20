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

const HOST   = process.env.LIVEKIT_HOST;   // https://<proj>.livekit.cloud   (HTTPS)
const WS_URL = process.env.LIVEKIT_WS_URL; //  wss://<proj>.livekit.cloud    (WSS)
const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;

if (!HOST || !WS_URL || !API_KEY || !API_SECRET) {
  console.error('Missing envs. Set LIVEKIT_HOST, LIVEKIT_WS_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET');
  process.exit(1);
}

const rooms  = new RoomServiceClient(HOST, API_KEY, API_SECRET);
const egress = new EgressClient(HOST, API_KEY, API_SECRET);

// Keep track of active egress so we can stop on End
const activeEgressByRoom = new Map(); // roomName -> Set<egressId>

// ---------- helpers ----------
const ROLES = ['admin', 'moderator', 'participant', 'observer'];
const isAdminish = (role) => role === 'admin' || role === 'moderator';

function buildGrantForRole(role, room) {
  // Base: everyone joins & can subscribe
  const grant = {
    roomJoin: true,
    room,
    canSubscribe: true,
  };

  if (role === 'observer') {
    grant.canPublish = false;
    grant.canPublishData = false;
  } else {
    grant.canPublish = true;
    grant.canPublishData = true;
  }

  if (isAdminish(role)) {
    grant.roomAdmin = true;
  }
  return grant;
}

// NOTE: toJwt() is async in v2
async function tokenFor({ room, identity, role }) {
  const at = new AccessToken(API_KEY, API_SECRET, {
    identity,
    // helpful on the client side to read role after connect
    metadata: JSON.stringify({ role }),
  });
  at.addGrant(buildGrantForRole(role, room));
  return await at.toJwt();
}

function ensureRole(role) {
  if (!role || !ROLES.includes(role)) {
    const allowed = ROLES.join(', ');
    const err = new Error(`Invalid or missing role. Allowed: ${allowed}`);
    err.status = 400;
    throw err;
  }
}

function ensureAdminish(role) {
  if (!isAdminish(role)) {
    const err = new Error('Forbidden: only admin/moderator allowed');
    err.status = 403;
    throw err;
  }
}

async function startAutoRecording(roomName) {
  // Create S3 MP4 output
  const file = new EncodedFileOutput({
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

  // Correct signature: second arg is an object, e.g. { file }
  const info = await egress.startRoomCompositeEgress(
    roomName,
    { file },
    { layout: 'grid' } // 'grid' | 'speaker' | 'single-speaker' | 'grid-light'
  );

  if (!activeEgressByRoom.has(roomName)) activeEgressByRoom.set(roomName, new Set());
  activeEgressByRoom.get(roomName).add(info.egressId);
  return info.egressId;
}

async function stopAllRecordings(roomName) {
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

// START meeting — admin/moderator only; auto-start recording
app.post('/api/meeting/start', async (req, res) => {
  try {
    const { roomName, username, role } = req.body || {};
    if (!roomName || !username) return res.status(400).json({ error: 'roomName and username required' });
    ensureRole(role);
    ensureAdminish(role);

    // ensure room exists
    try { await rooms.createRoom({ name: roomName, emptyTimeout: 60 * 60 }); } catch (_) {}

    // auto-record
    let egressId = null;
    try {
      egressId = await startAutoRecording(roomName);
    } catch (e) {
      console.error('Auto-record start error:', e?.message || e);
      // Do not block meeting if recording fails
    }

    // mint host token
    const token = await tokenFor({ room: roomName, identity: username, role });
    res.json({ roomName, token, wsUrl: WS_URL, role, egressId, recording: Boolean(egressId) });
  } catch (e) {
    res.status(e?.status || 500).json({ error: e?.message || 'Failed to start meeting' });
  }
});

// JOIN meeting — all roles allowed; participants/observers restricted via grant
app.post('/api/meeting/join', async (req, res) => {
  try {
    const { roomName, username, role = 'participant' } = req.body || {};
    if (!roomName || !username) return res.status(400).json({ error: 'roomName and username required' });
    ensureRole(role);

    // must already be started (by admin/moderator)
    const existing = await rooms.listRooms();
    const found = existing.find(r => r.name === roomName);
    if (!found) return res.status(404).json({ error: 'Room not started yet. Ask the host to Start meeting.' });

    const token = await tokenFor({ room: roomName, identity: username, role });
    res.json({ roomName, token, wsUrl: WS_URL, role });
  } catch (e) {
    res.status(e?.status || 500).json({ error: e?.message || 'Failed to join meeting' });
  }
});

// END meeting — admin/moderator only; stop recording first, then delete room
app.post('/api/meeting/end', async (req, res) => {
  try {
    const { roomName, role } = req.body || {};
    if (!roomName) return res.status(400).json({ error: 'roomName required' });
    ensureRole(role);
    ensureAdminish(role);

    await stopAllRecordings(roomName);
    await rooms.deleteRoom(roomName);
    res.json({ ok: true });
  } catch (e) {
    res.status(e?.status || 500).json({ error: e?.message || 'Failed to end meeting' });
  }
});

// Manual recording (optional) — admin/moderator only
app.post('/api/record/start', async (req, res) => {
  try {
    const { roomName, role, layout = 'grid', filename = '{room_name}-{time}.mp4' } = req.body || {};
    if (!roomName) return res.status(400).json({ error: 'roomName required' });
    ensureRole(role);
    ensureAdminish(role);

    const file = new EncodedFileOutput({
      filepath: filename,
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

    const info = await egress.startRoomCompositeEgress(roomName, { file }, { layout });
    if (!activeEgressByRoom.has(roomName)) activeEgressByRoom.set(roomName, new Set());
    activeEgressByRoom.get(roomName).add(info.egressId);

    res.json({ ok: true, egressId: info.egressId, status: info.status });
  } catch (e) {
    console.error('egress start error:', e?.message || e);
    res.status(e?.status || 500).json({ error: e?.message || 'Failed to start recording' });
  }
});

app.post('/api/record/stop', async (req, res) => {
  try {
    const { egressId, role, roomName } = req.body || {};
    ensureRole(role);
    ensureAdminish(role);
    if (!egressId) return res.status(400).json({ error: 'egressId required' });

    const info = await egress.stopEgress(egressId);
    if (roomName && activeEgressByRoom.has(roomName)) {
      activeEgressByRoom.get(roomName).delete(egressId);
      if (!activeEgressByRoom.get(roomName).size) activeEgressByRoom.delete(roomName);
    }
    res.json({ ok: true, status: info.status });
  } catch (e) {
    res.status(e?.status || 500).json({ error: e?.message || 'Failed to stop recording' });
  }
});

app.listen(process.env.PORT || 3001, () =>
  console.log(`LiveKit backend on :${process.env.PORT || 3001}`),
);
