import "dotenv/config";
import { createServer } from 'http';
import { Server as IOServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import express from "express";
import cors from "cors";
import {
  AccessToken,
  RoomServiceClient,
  EgressClient,
  SegmentedFileOutput,
  S3Upload,
  TrackSource,
  TrackType,
} from "livekit-server-sdk";

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(express.json());

const server = createServer(app);
const io = new IOServer(server, {
  cors: { origin: process.env.CORS_ORIGIN || true },
});

const HOST = process.env.LIVEKIT_HOST; // https://<proj>.livekit.cloud
const WS_URL = process.env.LIVEKIT_WS_URL; // wss://<proj>.livekit.cloud
const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;

// HLS CDN (CloudFront or similar) and S3 path prefix for segments
const HLS_PUBLIC_BASE = process.env.HLS_PUBLIC_BASE; // e.g. https://cdn.example.com
const HLS_PREFIX = process.env.HLS_PREFIX || "hls"; // folder prefix in your bucket

if (!HOST || !WS_URL || !API_KEY || !API_SECRET) {
  console.error(
    "Missing envs. Set LIVEKIT_HOST, LIVEKIT_WS_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET"
  );
  process.exit(1);
}

const rooms = new RoomServiceClient(HOST, API_KEY, API_SECRET);
const egress = new EgressClient(HOST, API_KEY, API_SECRET);

// Track active HLS egress per room so we can stop on End
const activeEgressByRoom = new Map(); // roomName -> Set<egressId>

// ---------- roles & grants ----------
const ROLES = ["admin", "moderator", "participant", "observer"];
const isAdminish = (role) => role === "admin" || role === "moderator";

// ---- MongoDB (whiteboard persistence only) ----
const MONGO = process.env.MONGODB_URI;
if (!MONGO) {
  console.warn('MONGODB_URI not set; whiteboard history won’t be persisted.');
} else {
  mongoose
    .connect(MONGO, { dbName: 'meet' })
    .then(() => console.log('Mongo connected'))
    .catch((e) => console.error('Mongo connection error', e?.message || e));
}

// Minimal stroke schema: one document per stroke segment
const WhiteboardStrokeSchema = new mongoose.Schema(
  {
    roomName: { type: String, index: true },
    sessionId: { type: String, index: true }, // changes each open/close
    seq: Number, // increasing sequence number per session
    author: { identity: String, name: String, role: String },
    tool: { type: String, default: 'pen' }, // 'pen' | 'eraser' (eraser is just draw with bg)
    color: { type: String, default: '#111' },
    size: { type: Number, default: 2 },
    points: [{ x: Number, y: Number }], // a polyline segment
    ts: { type: Number, default: () => Date.now() },
  },
  { versionKey: false }
);
const WhiteboardStroke = mongoose.models.WhiteboardStroke ||
  mongoose.model('WhiteboardStroke', WhiteboardStrokeSchema);


function ensureRole(role) {
  if (!role || !ROLES.includes(role)) {
    const err = new Error(
      `Invalid or missing role. Allowed: ${ROLES.join(", ")}`
    );
    err.status = 400;
    throw err;
  }
}

function ensureAdminish(role) {
  if (!isAdminish(role)) {
    const err = new Error("Forbidden: only admin/moderator allowed");
    err.status = 403;
    throw err;
  }
}

function grantFor(role, room) {
  const base = {
    roomJoin: true,
    room,
    canSubscribe: true,
    canPublishData: true,
  };

  if (role === "observer") {
    return {
      ...base,
      canPublish: false,
      canPublishData: false,
      canPublishSources: [],
    };
  }

  if (role === "participant") {
    return {
      ...base,
      canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA],
    };
  }

  // admin/moderator
  return {
    ...base,
    canPublish: true,
    roomAdmin: true,
    canPublishSources: [
      TrackSource.MICROPHONE,
      TrackSource.CAMERA,
      TrackSource.SCREEN_SHARE,
      TrackSource.SCREEN_SHARE_AUDIO,
    ],
  };
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
    playlistName: "index.m3u8",
    livePlaylistName: "live.m3u8",
    liveUrl: HLS_PUBLIC_BASE ? `${HLS_PUBLIC_BASE}/${dir}/live.m3u8` : null,
    vodUrl: HLS_PUBLIC_BASE ? `${HLS_PUBLIC_BASE}/${dir}/index.m3u8` : null,
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
      case: "s3",
      value: new S3Upload({
        accessKey: process.env.S3_ACCESS_KEY,
        secret: process.env.S3_SECRET,
        bucket: process.env.S3_BUCKET,
        region: process.env.S3_REGION,
        endpoint: process.env.S3_ENDPOINT || undefined,
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true" || undefined,
      }),
    },
  });

  // Start Room Composite with HLS (segments). This supports “live playlist” + VOD on S3. :contentReference[oaicite:1]{index=1}
  const info = await egress.startRoomCompositeEgress(
    roomName,
    { segments }, // EncodedOutputs.segments
    { layout: "grid" } // pick 'speaker' / 'single-speaker' / 'grid-light' if you prefer
  );

  if (!activeEgressByRoom.has(roomName))
    activeEgressByRoom.set(roomName, new Set());
  activeEgressByRoom.get(roomName).add(info.egressId);

  return info;
}

async function stopAllEgress(roomName) {
  const ids = activeEgressByRoom.get(roomName);
  if (ids && ids.size) {
    for (const id of ids) {
      try {
        await egress.stopEgress(id);
      } catch (e) {
        console.warn("stopEgress error", id, e?.message || e);
      }
    }
    activeEgressByRoom.delete(roomName);
  }
}

// ---------- routes ----------
app.get("/health", (_, res) => res.json({ ok: true }));

// START (admin/moderator only): create room, auto-start HLS, return token + HLS URLs
app.post("/api/meeting/start", async (req, res) => {
  try {
    const { roomName, username, role } = req.body || {};
    if (!roomName || !username)
      return res.status(400).json({ error: "roomName and username required" });
    ensureRole(role);
    ensureAdminish(role);

    // ensure room exists
    try {
      await rooms.createRoom({ name: roomName, emptyTimeout: 60 * 60 });
    } catch (_) {}

    // auto-start HLS egress (record + live)
    let egressInfo = null;
    try {
      egressInfo = await startHlsEgress(roomName);
    } catch (e) {
      console.error(
        "HLS start error:",
        e?.message || e
      ); /* don’t block meeting */
    }

    const token = await mintToken({ room: roomName, identity: username, role });
    const { liveUrl, vodUrl } = hlsPaths(roomName);

    res.json({
      roomName,
      role,
      token,
      wsUrl: WS_URL,
      hls: { liveUrl, vodUrl },
      egressId: egressInfo?.egressId || null,
    });
  } catch (e) {
    res
      .status(e?.status || 500)
      .json({ error: e?.message || "Failed to start meeting" });
  }
});

// JOIN (any role): participants get a token; observers just get HLS URLs (no need to connect)
app.post("/api/meeting/join", async (req, res) => {
  try {
    const { roomName, username, role = "participant" } = req.body || {};
    if (!roomName || !username)
      return res.status(400).json({ error: "roomName and username required" });
    ensureRole(role);

    const existing = await rooms.listRooms();
    const found = existing.find((r) => r.name === roomName);
    if (!found)
      return res
        .status(404)
        .json({
          error: "Room not started yet. Ask the host to Start meeting.",
        });

    const { liveUrl, vodUrl } = hlsPaths(roomName);

    if (role === "observer") {
      // Observers don’t need a token or to connect; they’ll play HLS.
      return res.json({ roomName, role, hls: { liveUrl, vodUrl } });
    }

    const token = await mintToken({ room: roomName, identity: username, role });
    res.json({
      roomName,
      role,
      token,
      wsUrl: WS_URL,
      hls: { liveUrl, vodUrl },
    });
  } catch (e) {
    res
      .status(e?.status || 500)
      .json({ error: e?.message || "Failed to join meeting" });
  }
});

// END (admin/moderator only): stop HLS then delete room
// const prevEndRoute = app._router.stack.find(l => l.route?.path === '/api/meeting/end'); // not required; here’s the body instead:
app.post("/api/meeting/end", async (req, res) => {
  try {
    const { roomName, role } = req.body || {};
    if (!roomName) return res.status(400).json({ error: "roomName required" });
    ensureRole(role);
    ensureAdminish(role);

    await stopAllEgress(roomName);
    await rooms.deleteRoom(roomName);

    const bos = await listBreakouts(roomName);
    for (const r of bos) {
      try {
        await closeBreakoutAndReturn(roomName, r);
      } catch {}
    }
    res.json({ ok: true });
  } catch (e) {
    res
      .status(e?.status || 500)
      .json({ error: e?.message || "Failed to end meeting" });
  }
});

// ==================== MODERATION ROUTES ====================

// Mute a participant's mic/camera/screenshare by identity.
// kind: 'audio' | 'video' | 'screenshare'
app.post("/api/mod/mute", async (req, res) => {
  try {
    const { roomName, role, identity, kind, mute = true } = req.body || {};
    if (!roomName || !identity || !kind)
      return res
        .status(400)
        .json({ error: "roomName, identity, kind required" });
    ensureRole(role);
    ensureAdminish(role);

    // fetch participant to find their track SIDs
    const p = await rooms.getParticipant(roomName, identity); // includes published tracks
    // p.tracks entries include { sid, type: TrackType, source: TrackSource, muted, ... }  :contentReference[oaicite:3]{index=3}

    // pick tracks by requested target
    let selected = [];
    if (kind === "audio") {
      selected = (p.tracks || []).filter((t) => t.type === TrackType.AUDIO);
    } else if (kind === "video") {
      // camera video only (exclude screenshare)
      selected = (p.tracks || []).filter(
        (t) => t.type === TrackType.VIDEO && t.source === TrackSource.CAMERA
      );
    } else if (kind === "screenshare") {
      selected = (p.tracks || []).filter(
        (t) =>
          t.source === TrackSource.SCREEN_SHARE ||
          t.source === TrackSource.SCREEN_SHARE_AUDIO
      );
    } else {
      return res.status(400).json({ error: "invalid kind" });
    }

    // call server API to mute/unmute each publication
    for (const t of selected) {
      await rooms.mutePublishedTrack(roomName, identity, t.sid, !!mute); // server-side moderation mute :contentReference[oaicite:4]{index=4}
    }

    res.json({
      ok: true,
      tracksAffected: selected.map((t) => ({
        sid: t.sid,
        type: t.type,
        source: t.source,
      })),
    });
  } catch (e) {
    res
      .status(e?.status || 500)
      .json({ error: e?.message || "Failed to mute" });
  }
});

// Allow / deny screen share for a participant (live).
// When deny=false->allow=true: we add SCREEN_SHARE* to canPublishSources.
// When allow=false: remove SCREEN_SHARE*, and also mute active screenshare tracks.

const pendingShareRequests = new Map();
const shareDecisionsByRoom = new Map();

app.post("/api/mod/screenshare", async (req, res) => {
  try {
    const { roomName, role, identity, allow } = req.body || {};
    if (!roomName || !identity || allow === undefined)
      return res
        .status(400)
        .json({ error: "roomName, identity, allow required" });
    ensureRole(role);
    ensureAdminish(role);

    const info = await rooms.getParticipant(roomName, identity);
    const current = info.permission || {}; // ParticipantPermission (may be undefined)  :contentReference[oaicite:5]{index=5}

    // Build next permission atomically. Preserve existing booleans; only change canPublishSources.
    // Start from whatever we have; default to publish mic/cam if not specified.
    const baseSources = Array.isArray(current.canPublishSources)
      ? [...current.canPublishSources]
      : [TrackSource.MICROPHONE, TrackSource.CAMERA];

    let nextSources = baseSources.filter(Boolean);

    const ensure = (s) => {
      if (!nextSources.includes(s)) nextSources.push(s);
    };
    const remove = (s) => {
      nextSources = nextSources.filter((x) => x !== s);
    };

    if (allow) {
      ensure(TrackSource.SCREEN_SHARE);
      ensure(TrackSource.SCREEN_SHARE_AUDIO);
    } else {
      remove(TrackSource.SCREEN_SHARE);
      remove(TrackSource.SCREEN_SHARE_AUDIO);
    }

    await rooms.updateParticipant(roomName, identity, {
      permission: {
        canPublish: current.canPublish ?? true,
        canPublishData: current.canPublishData ?? true,
        canSubscribe: current.canSubscribe ?? true,
        canPublishSources: nextSources, // <-- atomic set  :contentReference[oaicite:6]{index=6}
        hidden: current.hidden ?? false,
        // recorder: current.recorder ?? false,
        canUpdateMetadata: current.canUpdateMetadata ?? false,
      },
    });

    // If we just denied, also stop any ongoing share immediately.
    if (!allow) {
      const shareTracks = (info.tracks || []).filter(
        (t) =>
          t.source === TrackSource.SCREEN_SHARE ||
          t.source === TrackSource.SCREEN_SHARE_AUDIO
      );
      for (const t of shareTracks) {
        await rooms.mutePublishedTrack(roomName, identity, t.sid, true); // ensure the current share stops now :contentReference[oaicite:7]{index=7}
      }
    }

    res.json({ ok: true, allow, canPublishSources: nextSources });
  } catch (e) {
    res
      .status(e?.status || 500)
      .json({
        error: e?.message || "Failed to update screen-share permission",
      });
  }
});

app.post("/api/mod/screenshare/request", async (req, res) => {
  const { roomName, identity, name } = req.body || {};

  if (!roomName || !identity)
    return res.status(400).json({ error: "roomName and identity required" });

  if (!pendingShareRequests.has(roomName))
    pendingShareRequests.set(roomName, new Map());

  pendingShareRequests
    .get(roomName)
    .set(identity, { name: name || identity, at: Date.now() });

  // clear last decision for a new request
  shareDecisionsByRoom.get(roomName)?.delete(identity);

  res.json({ ok: true });
});

// Moderator/Admin pulls pending list
app.get("/api/mod/screenshare/pending", async (req, res) => {
  const { roomName, role } = req.query;
  ensureRole(role);
  ensureAdminish(role);
  const map = pendingShareRequests.get(roomName) || new Map();
  const items = Array.from(map.entries()).map(([identity, v]) => ({
    identity,
    ...v,
  }));
  res.json({ ok: true, items });
});

// Moderator/Admin decides
app.post("/api/mod/screenshare/decide", async (req, res) => {
  try {
    const { roomName, role, identity, allow } = req.body || {};
    if (!roomName || !identity || allow === undefined) {
      return res
        .status(400)
        .json({ error: "roomName, identity, allow required" });
    }
    ensureRole(role);
    ensureAdminish(role);

    const info = await rooms.getParticipant(roomName, identity);
    const current = info.permission || {};

    // Start with current sources or default MIC+CAMERA if missing
    let nextSources = Array.isArray(current.canPublishSources)
      ? [...current.canPublishSources]
      : [TrackSource.MICROPHONE, TrackSource.CAMERA];

    const add = (s) => {
      if (!nextSources.includes(s)) nextSources.push(s);
    };
    const rm = (s) => {
      nextSources = nextSources.filter((x) => x !== s);
    };

    if (allow) {
      add(TrackSource.SCREEN_SHARE);
      add(TrackSource.SCREEN_SHARE_AUDIO);
    } else {
      rm(TrackSource.SCREEN_SHARE);
      rm(TrackSource.SCREEN_SHARE_AUDIO);
    }

    await rooms.updateParticipant(roomName, identity, {
      permission: {
        canPublish: current.canPublish ?? true,
        canPublishData: current.canPublishData ?? true,
        canSubscribe: current.canSubscribe ?? true,
        canPublishSources: nextSources,
        hidden: current.hidden ?? false,
        recorder: current.recorder ?? false,
        canUpdateMetadata: current.canUpdateMetadata ?? false,
      },
    });

    // If denied, also force-stop any active screenshare tracks
    if (!allow) {
      const shareTracks = (info.tracks || []).filter(
        (t) =>
          t.source === TrackSource.SCREEN_SHARE ||
          t.source === TrackSource.SCREEN_SHARE_AUDIO
      );
      for (const t of shareTracks) {
        await rooms.mutePublishedTrack(roomName, identity, t.sid, true);
      }
    }

    // remove from pending list
    pendingShareRequests.get(roomName)?.delete(identity);

    if (!shareDecisionsByRoom.has(roomName))
      shareDecisionsByRoom.set(roomName, new Map());
    shareDecisionsByRoom
      .get(roomName)
      .set(identity, allow ? "allowed" : "denied");

    res.json({ ok: true, allow, canPublishSources: nextSources });
  } catch (e) {
    res
      .status(e?.status || 500)
      .json({ error: e?.message || "Failed to decide screen-share" });
  }
});

// (Optional) Participant polls to know if now allowed
app.get("/api/participant/canshare", async (req, res) => {
  try {
    const { roomName, identity } = req.query;
    if (!roomName || !identity)
      return res.status(400).json({ error: "roomName and identity required" });
    const p = await rooms.getParticipant(roomName, identity);
    const canShare =
      Array.isArray(p.permission?.canPublishSources) &&
      (p.permission.canPublishSources.includes(TrackSource.SCREEN_SHARE) ||
        p.permission.canPublishSources.includes(
          TrackSource.SCREEN_SHARE_AUDIO
        ));
    res.json({ ok: true, canShare });
  } catch (e) {
    res
      .status(e?.status || 500)
      .json({ error: e?.message || "Failed to query permission" });
  }
});

app.get("/api/participant/share-status", async (req, res) => {
  try {
    const { roomName, identity } = req.query;
    if (!roomName || !identity)
      return res.status(400).json({ error: "roomName and identity required" });

    const pendingMap = pendingShareRequests.get(roomName);
    const pending = !!pendingMap?.has(identity);

    // check current permission
    let canShare = false;
    try {
      const p = await rooms.getParticipant(roomName, identity);
      const sources = p.permission?.canPublishSources || [];
      canShare =
        sources.includes(TrackSource.SCREEN_SHARE) ||
        sources.includes(TrackSource.SCREEN_SHARE_AUDIO);
    } catch {
      // participant may not be in room yet — treat as not allowed
      canShare = false;
    }

    const decision = shareDecisionsByRoom.get(roomName)?.get(identity) || null;

    res.json({ ok: true, pending, canShare, decision }); // decision: 'allowed' | 'denied' | null
  } catch (e) {
    res.status(500).json({ error: e?.message || "Failed to get status" });
  }
});

const breakoutsByParent = new Map();
const breakoutTimers = new Map();

const breakoutName = (parentRoom, label) => {
  const slug = String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9-_ ]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 48);
  if (!slug) throw new Error("invalid breakout label");
  return `${parentRoom}__bo__${slug}`;
};

// helper: register a breakout room for a parent
function registerBreakout(parentRoom, bo) {
  if (!breakoutsByParent.has(parentRoom))
    breakoutsByParent.set(parentRoom, new Set());
  breakoutsByParent.get(parentRoom).add(bo);
}

// helper: list current breakouts for a parent (combine memory + live rooms prefix)
async function listBreakouts(parentRoom) {
  const prefix = `${parentRoom}__bo__`;
  const fromMem = Array.from(breakoutsByParent.get(parentRoom) || []);
  // recover from server state too (in case of server restarts)
  let fromServer = [];
  try {
    const roomsList = await rooms.listRooms();
    fromServer = roomsList
      .map((r) => r.name)
      .filter((n) => n.startsWith(prefix));
  } catch {}
  return Array.from(new Set([...fromMem, ...fromServer]));
}

function setBreakoutTimer(parentRoom, breakout, minutes) {
  clearBreakoutTimer(parentRoom, breakout);
  if (!minutes || minutes <= 0) return; // no timer
  const ms = minutes * 60 * 1000;
  const endAt = Date.now() + ms;

  const to = setTimeout(() => {
    // on expiry: close & move everyone back
    closeBreakoutAndReturn(parentRoom, breakout).catch((e) =>
      console.warn("auto-close breakout failed", breakout, e?.message || e)
    );
  }, ms);

  if (!breakoutTimers.has(parentRoom))
    breakoutTimers.set(parentRoom, new Map());
  breakoutTimers.get(parentRoom).set(breakout, { timeout: to, endAt });
}

function clearBreakoutTimer(parentRoom, breakout) {
  const m = breakoutTimers.get(parentRoom);
  const rec = m?.get(breakout);
  if (rec?.timeout) clearTimeout(rec.timeout);
  m?.delete(breakout);
  if (m && m.size === 0) breakoutTimers.delete(parentRoom);
}

function getBreakoutEndAt(parentRoom, breakout) {
  return breakoutTimers.get(parentRoom)?.get(breakout)?.endAt || null;
}

async function closeBreakoutAndReturn(parentRoom, breakout) {
  try {
    // 1) move everyone back (best-effort)
    const ps = await rooms.listParticipants(breakout);
    for (const p of ps || []) {
      try {
        await rooms.moveParticipant(breakout, p.identity, parentRoom);
      } catch {}
    }
  } catch {}
  // 2) stop egress & delete room
  try {
    await stopAllEgress(breakout);
  } catch {}
  try {
    await rooms.deleteRoom(breakout);
  } catch {}
  breakoutsByParent.get(parentRoom)?.delete(breakout);
  clearBreakoutTimer(parentRoom, breakout);
}
// we already have: startHlsEgress(roomName) + hlsPaths(roomName) + stopAllEgress(roomName)

// ====== NEW: Create a breakout (admin/mod only), auto-start HLS ======
// create breakout
app.post("/api/breakouts/create", async (req, res) => {
  try {
    const { parentRoom, label, role, durationMinutes } = req.body || {};
    if (!parentRoom || !label)
      return res.status(400).json({ error: "parentRoom and label required" });
    ensureRole(role);
    ensureAdminish(role);

    const boRoom = breakoutName(parentRoom, label);

    try {
      await rooms.createRoom({ name: boRoom, emptyTimeout: 60 * 60 });
    } catch {}

    // auto-start HLS
    let egressInfo = null;
    try {
      egressInfo = await startHlsEgress(boRoom);
    } catch (e) {
      console.error("HLS start error (breakout):", e?.message || e);
    }

    registerBreakout(parentRoom, boRoom);

    // schedule timer (optional)
    const mins = Number(durationMinutes) || 0;
    setBreakoutTimer(parentRoom, boRoom, mins);

    const { liveUrl, vodUrl } = hlsPaths(boRoom);
    res.json({
      ok: true,
      breakout: boRoom,
      hls: { liveUrl, vodUrl },
      egressId: egressInfo?.egressId || null,
      endAt: getBreakoutEndAt(parentRoom, boRoom),
    });
  } catch (e) {
    res
      .status(e?.status || 500)
      .json({ error: e?.message || "Failed to create breakout" });
  }
});

app.post("/api/breakouts/extend", async (req, res) => {
  try {
    const { parentRoom, breakout, role, addMinutes } = req.body || {};
    if (!parentRoom || !breakout)
      return res
        .status(400)
        .json({ error: "parentRoom and breakout required" });
    ensureRole(role);
    ensureAdminish(role);

    const currentEnd = getBreakoutEndAt(parentRoom, breakout);
    const remainingMs =
      currentEnd && currentEnd > Date.now() ? currentEnd - Date.now() : 0;
    const extraMs = (Number(addMinutes) || 0) * 60 * 1000;
    const totalMinutes = Math.ceil((remainingMs + extraMs) / 60000);

    setBreakoutTimer(parentRoom, breakout, totalMinutes);
    res.json({ ok: true, endAt: getBreakoutEndAt(parentRoom, breakout) });
  } catch (e) {
    res
      .status(e?.status || 500)
      .json({ error: e?.message || "Failed to extend breakout" });
  }
});

// ====== NEW: Close a breakout (admin/mod only): stop egress + delete room ======
app.post("/api/breakouts/close", async (req, res) => {
  try {
    const { parentRoom, breakout, role } = req.body || {};
    if (!parentRoom || !breakout)
      return res
        .status(400)
        .json({ error: "parentRoom and breakout required" });
    ensureRole(role);
    ensureAdminish(role);

    await closeBreakoutAndReturn(parentRoom, breakout);
    res.json({ ok: true });
  } catch (e) {
    res
      .status(e?.status || 500)
      .json({ error: e?.message || "Failed to close breakout" });
  }
});

// ====== NEW: Move a participant to another room (admin/mod only) ======
// Uses RoomServiceClient.moveParticipant (Cloud/Private Cloud feature).
app.post("/api/breakouts/move", async (req, res) => {
  try {
    const { fromRoom, identity, toRoom, role } = req.body || {};
    if (!fromRoom || !identity || !toRoom)
      return res
        .status(400)
        .json({ error: "fromRoom, identity, toRoom required" });
    ensureRole(role);
    ensureAdminish(role);

    await rooms.moveParticipant(fromRoom, identity, toRoom); // seamless move server-side
    res.json({ ok: true });
  } catch (e) {
    res
      .status(e?.status || 500)
      .json({ error: e?.message || "Failed to move participant" });
  }
});

// ====== NEW: Introspection endpoints ======

// List current breakout state (+ HLS URLs) for observers and UI
app.get("/api/breakouts/state", async (req, res) => {
  const { parentRoom } = req.query || {};
  if (!parentRoom)
    return res.status(400).json({ error: "parentRoom required" });

  const boList = await listBreakouts(parentRoom);
  const main = { roomName: parentRoom, ...hlsPaths(parentRoom) };
  const breakouts = boList.map((r) => ({
    roomName: r,
    ...hlsPaths(r),
    endAt: getBreakoutEndAt(parentRoom, r),
  }));

  res.json({ ok: true, main, breakouts });
});

// List participants of any room (for cross-room moves)
app.get("/api/room/participants", async (req, res) => {
  try {
    const { roomName, role } = req.query || {};
    ensureRole(role);
    ensureAdminish(role);
    if (!roomName) return res.status(400).json({ error: "roomName required" });

    const ps = await rooms.listParticipants(roomName);

      const items = (ps || [])
        .filter(p => {
          const k = p.kind ?? 'standard';
          // server enum: 0 = STANDARD; string mode: 'standard'
          const isStandard = (typeof k === 'string') ? k === 'standard' : k === 0;
          const isHidden  = !!p.permission?.hidden;
          return isStandard && !isHidden;
        })
      .map((p) => ({ identity: p.identity, name: p.name || p.identity }));

    res.json({ ok: true, items });
  } catch (e) {
    res
      .status(e?.status || 500)
      .json({ error: e?.message || "Failed to list participants" });
  }
});

// ---- Whiteboard state (in-memory) ----
// For each LiveKit room we track current whiteboard session + permissions
const wbStateByRoom = new Map();
/*
  wbState = {
    open: boolean,
    sessionId: string,
    seq: number,                 // last committed sequence
    rolesAllowed: new Set(['admin','moderator','participant']) // default
  }
*/

function getOrInitWB(roomName) {
  let s = wbStateByRoom.get(roomName);
  if (!s) {
    s = {
      open: false,
      sessionId: '',
      seq: 0,
      rolesAllowed: new Set(['admin', 'moderator', 'participant']), // observers cannot draw
    };
    wbStateByRoom.set(roomName, s);
  }
  return s;
}

// Verify the LiveKit JWT you already mint and extract identity/role safely.
// We expect client to pass that token when connecting Socket.IO.
function decodeLKToken(token) {
  // LiveKit token is a JWT signed using your API_SECRET
  const decoded = jwt.verify(token, API_SECRET, { algorithms: ['HS256'] });
  // LiveKit puts custom metadata as string; parse if present
  let role = 'participant';
  try {
    if (decoded?.metadata) {
      const md = JSON.parse(decoded.metadata);
      if (md?.role) role = md.role;
    }
  } catch {}
  const identity = decoded?.sub || decoded?.name || 'unknown';
  return { identity, role };
}

function canDraw(role, wb) {
  if (!wb?.open) return false;
  if (!role) return false;
  // observers never
  if (role === 'observer') return false;
  // default rolesAllowed contains admin/mod/participant
  return wb.rolesAllowed.has(role);
}

// ---- Whiteboard REST ----

// Open whiteboard (admin/mod only). Starts a fresh sessionId.
app.post('/api/wb/open', async (req, res) => {
  try {
    const { roomName, role } = req.body || {};
    if (!roomName) return res.status(400).json({ error: 'roomName required' });
    ensureRole(role);
    ensureAdminish(role);

    const wb = getOrInitWB(roomName);
  
       // If in-memory session is empty, try to recover from DB; else create new.
       if (!wb.sessionId) {
         if (mongoose.connection.readyState === 1) {
           const last = await WhiteboardStroke.findOne({ roomName })
             .sort({ ts: -1, seq: -1 })
             .lean();
           if (last?.sessionId) {
             wb.sessionId = last.sessionId;
             wb.seq = last.seq || 0;
           }
         }
         if (!wb.sessionId) {
           wb.sessionId = `${roomName}_${Date.now()}`;
           wb.seq = 0;
         }
       }

    wb.open = true;
    // IMPORTANT: do NOT reset wb.seq here if session already exists.
    io.to(`wb:${roomName}`).emit('wb:state', { open: true, sessionId: wb.sessionId });

    res.json({ ok: true, sessionId: wb.sessionId });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'Failed to open whiteboard' });
  }
});

// Close whiteboard (admin/mod only)
app.post('/api/wb/close', async (req, res) => {
  try {
    const { roomName, role } = req.body || {};
    if (!roomName) return res.status(400).json({ error: 'roomName required' });
    ensureRole(role);
    ensureAdminish(role);

    const wb = getOrInitWB(roomName);
    wb.open = false;

    io.to(`wb:${roomName}`).emit('wb:state', { open: false, sessionId: wb.sessionId });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'Failed to close whiteboard' });
  }
});

// (Optional) Restrict or relax who can draw by role — admin/mod only
app.post('/api/wb/roles', async (req, res) => {
  try {
    const { roomName, role, rolesAllowed } = req.body || {};
    if (!roomName) return res.status(400).json({ error: 'roomName required' });
    ensureRole(role);
    ensureAdminish(role);
    const valid = new Set(['admin', 'moderator', 'participant']); // observers excluded
    const incoming = new Set((rolesAllowed || []).filter((r) => valid.has(r)));
    const wb = getOrInitWB(roomName);
    wb.rolesAllowed = incoming.size ? incoming : new Set(['admin', 'moderator', 'participant']);
    io.to(`wb:${roomName}`).emit('wb:roles', Array.from(wb.rolesAllowed));
    res.json({ ok: true, rolesAllowed: Array.from(wb.rolesAllowed) });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'Failed to update roles' });
  }
});

// Fetch whiteboard history (for replay/export)
// If sessionId omitted, returns latest (current) session strokes.
app.get('/api/wb/history', async (req, res) => {
  try {
    const { roomName, sessionId } = req.query || {};
    if (!roomName) return res.status(400).json({ error: 'roomName required' });
    const wb = getOrInitWB(roomName);

     let sid = sessionId || wb.sessionId;
   if (!sid && mongoose.connection.readyState === 1) {
     // Find the most recent stroke for this room to recover its session
     const last = await WhiteboardStroke.findOne({ roomName })
       .sort({ ts: -1, seq: -1 })
       .lean();
     if (last?.sessionId) sid = last.sessionId;
   }
   if (!sid) return res.json({ ok: true, strokes: [] });

    const strokes = await WhiteboardStroke
      .find({ roomName, sessionId: sid })
      .sort({ seq: 1 })
      .lean();


    res.json({ ok: true, sessionId: sid, strokes });
  } catch (e) {
    res.status(500).json({ error: e?.message || 'Failed to fetch history' });
  }
});

// ---- Socket.IO: Whiteboard realtime ----
io.on('connection', (socket) => {
  // Expect query: ?roomName=...&token=LK_JWT
  const { roomName, token } = socket.handshake.query || {};

  if (!roomName || !token) {
    socket.emit('wb:error', 'roomName and token required');
    return socket.disconnect(true);
  }

  // Verify LiveKit JWT to trust identity+role
  let identity = 'unknown';
  let role = 'participant';
  try {
    const dec = decodeLKToken(String(token));
    identity = dec.identity;
    role = dec.role;
    ensureRole(role);
  } catch (e) {
    socket.emit('wb:error', 'invalid token');
    return socket.disconnect(true);
  }

  const roomKey = `wb:${roomName}`;
  socket.join(roomKey);

  // Send current state to this client
  const wb = getOrInitWB(String(roomName));
  socket.emit('wb:state', { open: wb.open, sessionId: wb.sessionId });
  socket.emit('wb:roles', Array.from(wb.rolesAllowed));

  // Join/leave logs (optional)
  // console.log(`[wb] ${identity} (${role}) connected to ${roomName}`);

  // Client requests: start drawing stream (the client decides when to send strokes)
  socket.on('wb:stroke', async (payload) => {
    // payload = { tool, color, size, points: [{x,y},...], name? }
    try {
      const wb = getOrInitWB(String(roomName));
      if (!canDraw(role, wb)) return; // ignore silently if not permitted
      if (!Array.isArray(payload?.points) || payload.points.length === 0) return;

      wb.seq += 1;
      const strokeDoc = {
        roomName: String(roomName),
        sessionId: wb.sessionId,
        seq: wb.seq,
        author: { identity, name: payload?.name || identity, role },
        tool: payload?.tool || 'pen',
        color: payload?.color || '#111',
        size: Number(payload?.size || 2),
        points: payload.points.map((p) => ({ x: Number(p.x), y: Number(p.y) })),
        ts: Date.now(),
      };

      // Persist if DB available
      if (mongoose.connection.readyState === 1) {
        try { await WhiteboardStroke.create(strokeDoc); } catch {}
      }

      // Broadcast to others in the room (including sender for idempotent UI)
      io.to(roomKey).emit('wb:stroke', strokeDoc);
    } catch (e) {
      // swallow
    }
  });

  // Clear board (admin/mod only). Frontend should confirm before sending.
  socket.on('wb:clear', async () => {
    try {
      ensureAdminish(role);
      const wb = getOrInitWB(String(roomName));
      if (!wb.open) return;
      // Logical clear = bump session to keep history of previous content,
      // or do a "soft clear event" and keep same session.
      // Here we soft-clear but keep session id; client erases canvas.
      io.to(roomKey).emit('wb:clear');
    } catch (e) {}
  });

  // Simple ping for presence/latency
  socket.on('wb:ping', () => socket.emit('wb:pong', Date.now()));

  socket.on('disconnect', () => {
    // console.log(`[wb] ${identity} left ${roomName}`);
  });
});


server.listen(process.env.PORT || 3001, () =>
  console.log(`LiveKit backend + sockets on :${process.env.PORT || 3001}`)
);
