/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Room, RoomEvent, DisconnectReason } from "livekit-client";
import {
  RoomContext,
  GridLayout,
  ParticipantTile,
  ControlBar,
  RoomAudioRenderer,
  useTracks,
} from "@livekit/components-react";
import "@livekit/components-styles";
import Hls from "hls.js";
import type { RemoteParticipant } from "livekit-client";
import type {
  Participant,
  TrackPublication,
  LocalParticipant,
} from "livekit-client";
import { Track } from "livekit-client";
import {
  ParticipantPermission,
  TrackSource as ProtoTrackSource,
} from "@livekit/protocol";
import { io, Socket } from "socket.io-client";

type Role = "admin" | "moderator" | "participant" | "observer";

export default function Page() {
  const [roomName, setRoomName] = useState("");
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<Role>("participant");

  const [connected, setConnected] = useState(false);
  const [hlsLiveUrl, setHlsLiveUrl] = useState<string | null>(null);
  const [room] = useState(
    () => new Room({ adaptiveStream: true, dynacast: true })
  );
  const [wbOpen, setWbOpen] = useState(false);

  // 👇 store the LiveKit token we get from /api/meeting/start|join
  const [lkToken, setLkToken] = useState<string | null>(null);

  // 👇 socket reference (one per meeting)
  const wbSocketRef = useRef<Socket | null>(null);

  const isAdminish = role === "admin" || role === "moderator";

  useEffect(() => {
    return () => {
      try {
        wbSocketRef.current?.disconnect();
      } catch {}
      room.disconnect();
    };
  }, [room]);

  const isLocalParticipant = (p: Participant): p is LocalParticipant =>
    p.isLocal === true;

  useEffect(() => {
    if (!connected) return;
    const lp = room.localParticipant;

    // helper: stop local capture if it's running
    const stopLocalShare = async () => {
      try {
        // If a local screenshare publication exists, force-unpublish it.
        const pub = lp.getTrackPublication(Track.Source.ScreenShare);
        if (pub) {
          await lp.setScreenShareEnabled(false);
        }
        const pubAudio = lp.getTrackPublication(Track.Source.ScreenShareAudio);
        if (pubAudio) {
          await lp.setScreenShareEnabled(false);
        }
      } catch {}
    };

    // 1) If server revokes our ability to publish screenshare, shut it down locally.
    const onPerms = (
      _prev: ParticipantPermission | undefined,
      participant: Participant
    ) => {
      if (!isLocalParticipant(participant)) return;

      const sources = participant.permissions?.canPublishSources ?? [];

      // Per docs: if canPublishSources is empty/undefined, all sources are allowed.
      const allowed =
        sources.length === 0 ||
        sources.includes(ProtoTrackSource.SCREEN_SHARE) ||
        sources.includes(ProtoTrackSource.SCREEN_SHARE_AUDIO);

      if (!allowed) stopLocalShare();
    };

    const onMuted = (
      publication: TrackPublication,
      participant: Participant
    ) => {
      if (!isLocalParticipant(participant)) return;
      const src = publication.source;
      if (
        src === Track.Source.ScreenShare ||
        src === Track.Source.ScreenShareAudio
      ) {
        stopLocalShare();
      }
    };

    room.on(RoomEvent.ParticipantPermissionsChanged, onPerms);
    room.on(RoomEvent.TrackMuted, onMuted);

    return () => {
      room.off(RoomEvent.ParticipantPermissionsChanged, onPerms);
      room.off(RoomEvent.TrackMuted, onMuted);
    };
  }, [room, connected]);

  // hydrate board when it opens (replay past strokes for current session)
useEffect(() => {
  if (!wbOpen) return;
  let cancelled = false;

  (async () => {
    try {
      const u = new URL(`${process.env.NEXT_PUBLIC_API_BASE}/api/wb/history`);
      u.searchParams.set("roomName", roomName);
      const r = await fetch(u.toString(), { cache: "no-store" });
      const d = await r.json();
      if (!cancelled && d?.ok && Array.isArray(d.strokes)) {
        // replay
        for (const s of d.strokes) {
          (globalThis as any).__wbOnStroke?.(s);
        }
      }
    } catch {}
  })();

  return () => { cancelled = true; };
}, [wbOpen, roomName]);


  async function startOrJoin(kind: "start" | "join") {
    const resp = await fetch(
      `${process.env.NEXT_PUBLIC_API_BASE}/api/meeting/${kind}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomName, username, role }),
      }
    );
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Request failed");

    // sync role if server modified it
    if (data.role) setRole(data.role);
    if (data.hls?.liveUrl) setHlsLiveUrl(data.hls.liveUrl);

    if (role === "observer") {
      // Observers do not connect to LiveKit; they will just view HLS
      setConnected(true);
      return;
    }

    await room.connect(
      data.wsUrl || process.env.NEXT_PUBLIC_LIVEKIT_URL!,
      data.token
    );
    setLkToken(data.token);
    room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      if (reason === DisconnectReason.ROOM_DELETED)
        alert("Meeting ended by host.");
      setConnected(false);
      setHlsLiveUrl(null);
      setWbOpen(false);
      try {
        wbSocketRef.current?.disconnect();
      } catch {}
      wbSocketRef.current = null;
    });

    setConnected(true);
    // 👇 after LiveKit connect, also connect the whiteboard socket
    //     (safe to call multiple times; we guard by ref)
    maybeConnectWhiteboardSocket(roomName, data.token);
  }

  function maybeConnectWhiteboardSocket(roomName: string, token: string) {
    if (wbSocketRef.current || !token) return;

    const s = io(process.env.NEXT_PUBLIC_API_BASE!, {
      path: "/socket.io", // default; change if you mount Socket.IO at a custom path
      transports: ["websocket"],
      query: { roomName, token },
    });

    wbSocketRef.current = s;

    // server pushes whether the board is open + current session id
    s.on("wb:state", (st: { open: boolean }) => setWbOpen(st.open));
    s.on("wb:roles", (_roles: string[]) => {
      // could show a UI hint if current role can/can’t draw
    });

    // forward strokes + clears to the canvas module
    s.on("wb:stroke", (doc: any) => (globalThis as any).__wbOnStroke?.(doc));
    s.on("wb:clear", () => (globalThis as any).__wbClearLocal?.());
    s.on("wb:error", (msg: string) => console.warn("[wb:error]", msg));

    // optional: ping/pong latency
    // s.emit("wb:ping");
    // s.on("wb:pong", (ts) => console.log("pong", ts));
  }

  async function endMeeting() {
    await fetch(`${process.env.NEXT_PUBLIC_API_BASE}/api/meeting/end`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomName, role }),
    });
    room.disconnect();
    try {
      wbSocketRef.current?.disconnect();
    } catch {}
    wbSocketRef.current = null;

    setConnected(false);
    setHlsLiveUrl(null);
    setWbOpen(false);
  }

  if (!connected) {
    return (
      <main style={{ padding: 24, maxWidth: 520 }}>
        <h1>LiveKit Meeting (HLS observers + built‑in Whiteboard)</h1>

        <label style={{ display: "block", marginBottom: 4 }}>Role</label>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          style={{ marginBottom: 12 }}
        >
          <option value="admin">admin</option>
          <option value="moderator">moderator</option>
          <option value="participant">participant</option>
          <option value="observer">observer (HLS view-only)</option>
        </select>

        <input
          className=" border-2 border-gray-300 rounded-md p-2"
          placeholder="Room name"
          value={roomName}
          onChange={(e) => setRoomName(e.target.value)}
        />
        <input
          className=" border-2 border-gray-300 rounded-md p-2"
          placeholder="Your name"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />

        <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
          <button
            className="bg-blue-500 text-white rounded-md p-2"
            onClick={() => startOrJoin("start")}
            disabled={!isAdminish}
          >
            Start meeting (admin/mod)
          </button>
          <button
            className="bg-blue-500 text-white rounded-md p-2"
            onClick={() => startOrJoin("join")}
          >
            Join
          </button>
        </div>

        <p style={{ marginTop: 8, color: "#666" }}>
          Admin/moderator can start/end. Participants join as normal. Observers
          don’t appear in the grid and watch the HLS stream.
        </p>
      </main>
    );
  }

  // OBSERVER VIEW: HLS player only (no LiveKit connection)
  if (role === "observer") {
    return (
      <ObserverSelectStream parentRoom={roomName} initialMain={hlsLiveUrl} />
    );
  }

  // ----------------------------------------------------------------
  // Whiteboard open/close actions
  // For admins/moderators we call REST so the server broadcasts to all.
  // Participants simply follow server-pushed wb:state.
  // ----------------------------------------------------------------
  const toggleWhiteboard = async () => {
    if (!lkToken || !wbSocketRef.current) {
      // if someone opens the board immediately after join, make sure we have socket
      if (lkToken) maybeConnectWhiteboardSocket(roomName, lkToken);
    }
    try {
      if (isAdminish) {
        if (!wbOpen) {
          await fetch(`${process.env.NEXT_PUBLIC_API_BASE}/api/wb/open`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ roomName, role }),
          });
        } else {
          await fetch(`${process.env.NEXT_PUBLIC_API_BASE}/api/wb/close`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ roomName, role }),
          });
        }
        // state will flip via wb:state broadcast
      } else {
        // non-admins can’t force-open/close; they just follow wb:state
        setWbOpen((v) => v); // no-op
      }
    } catch (e: any) {
      alert(e?.message || "Whiteboard action failed");
    }
  };

  // PARTICIPANT / ADMIN / MODERATOR VIEW: LiveKit grid
  return (
    <RoomContext.Provider value={room}>
      <div
        data-lk-theme="default"
        style={{
          height: "100dvh",
          display: "grid",
          gridTemplateColumns: isAdminish ? "1fr 360px" : "1fr",
        }}
      >
        <div style={{ position: "relative" }}>
          <MyVideoConference />
          <RoomAudioRenderer />

          {/* floating controls */}
          <div
            style={{
              position: "fixed",
              bottom: "calc(var(--lk-control-bar-height) + 12px)",
              left: 16,
              display: "flex",
              gap: 8,
              zIndex: 10,
            }}
          >
            {role === "participant" && (
              <RequestShare
                roomName={roomName}
                username={username}
                onAllowed={() =>
                  alert(
                    "Moderator allowed screen share. Use the Screen Share button to start."
                  )
                }
              />
            )}
            {/* Whiteboard toggle */}
            {isAdminish && (
              <button className="lk-button" onClick={toggleWhiteboard}>
                {wbOpen ? "Close Whiteboard" : "Open Whiteboard"}
              </button>
            )}

            {/* download whiteboard snapshot is inside WB itself */}
          </div>
          {/* Admin/mod can end meeting; no recording buttons */}
          {isAdminish && (
            <div
              style={{
                position: "fixed",
                bottom: "calc(var(--lk-control-bar-height) + 12px)",
                right: 16,
                zIndex: 10,
              }}
            >
              <button
                className="lk-button lk-button-danger"
                onClick={endMeeting}
              >
                End meeting
              </button>
            </div>
          )}

          {/* Whiteboard overlay (no package) */}
          {wbOpen && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 9,
                display: "grid",
                gridTemplateRows: "auto 1fr",
                background: "rgba(0,0,0,0.02)",
                borderTop: "1px solid #eee",
              }}
            >
              <WhiteboardToolbar socketRef={wbSocketRef} />
              <WhiteboardCanvas socketRef={wbSocketRef} />
            </div>
          )}

          <ControlBar />
        </div>
        {isAdminish && (
          <ModeratorPanel room={room} roomName={roomName} role={role} />
        )}
        {isAdminish && (
          <BreakoutsPanel parentRoom={roomName} room={room} role={role} />
        )}
      </div>
    </RoomContext.Provider>
  );
}

function MyVideoConference() {
  // Keep camera placeholders so the grid looks nice when cams are off
  const camRefs = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }],
    { onlySubscribed: false }
  );

  // For screen-share: no placeholders, and only include active (non-muted) shares
  const ssAll = useTracks(
    [{ source: Track.Source.ScreenShare, withPlaceholder: false }],
    { onlySubscribed: true }
  );

  const ssActive = ssAll.filter((ref) => {
    const pub = ref.publication;
    return !!(pub && pub.isSubscribed && !pub.isMuted && pub.track);
  });

  const tracks = [...camRefs, ...ssActive];

  return (
    <GridLayout
      tracks={tracks}
      style={{ height: "calc(100vh - var(--lk-control-bar-height))" }}
    >
      <ParticipantTile />
    </GridLayout>
  );
}

/* ================= WHITEBOARD (pure canvas + LiveKit data) =================
   Messages:
   { t:'wb:seg', x1,y1,x2,y2, color, size, erase?:boolean }     // draw line
   { t:'wb:clear' }                                             // clear all
   Coords are normalized [0..1] so different canvas sizes stay in sync.
   ======================================================================== */

const enc = new TextEncoder();
const dec = new TextDecoder();

function useWbTools() {
  const [color, setColor] = useState<string>("#111111");
  const [size, setSize] = useState<number>(3);
  const [erase, setErase] = useState<boolean>(false);
  // expose as a context-ish singleton (since we’re a single file)
  (globalThis as any).__wbTools = { color, size, erase };
  return { color, setColor, size, setSize, erase, setErase };
}

function WhiteboardToolbar({
  socketRef,
}: {
  socketRef: React.MutableRefObject<Socket | null>;
}) {
  const { color, setColor, size, setSize, erase, setErase } = useWbTools();
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        padding: 8,
        background: "white",
        borderBottom: "1px solid #eee",
      }}
    >
      <span style={{ fontWeight: 600 }}>Whiteboard</span>
      <label>
        Color:{" "}
        <input
          type="color"
          value={color}
          onChange={(e) => setColor(e.target.value)}
        />
      </label>
      <label>
        Size:{" "}
        <input
          type="range"
          min={1}
          max={20}
          value={size}
          onChange={(e) => setSize(Number(e.target.value))}
        />
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <input
          type="checkbox"
          checked={erase}
          onChange={(e) => setErase(e.target.checked)}
        />{" "}
        Eraser
      </label>
      <button
        className="lk-button"
        onClick={() => {
          // only admin/mod will be honored by backend
          socketRef.current?.emit("wb:clear");
        }}
      >
        Clear
      </button>
      <button
        className="lk-button"
        onClick={() => {
          const link = document.createElement("a");
          const url = (globalThis as any).__wbToDataURL?.();
          if (!url) return;
          link.href = url;
          link.download = `whiteboard-${Date.now()}.png`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        }}
      >
        Download PNG
      </button>
    </div>
  );
}

function WhiteboardCanvas({
  socketRef,
}: {
  socketRef: React.MutableRefObject<Socket | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isDown, setIsDown] = useState(false);
  const lastPt = useRef<{ x: number; y: number } | null>(null);

  // expose helpers for toolbar and socket listeners
  useEffect(() => {
    (globalThis as any).__wbClearLocal = () => {
      const cvs = canvasRef.current!;
      const ctx = cvs.getContext("2d")!;
      ctx.clearRect(0, 0, cvs.width, cvs.height);
    };
    (globalThis as any).__wbToDataURL = () => {
      const cvs = canvasRef.current!;
      return cvs.toDataURL("image/png");
    };
    (globalThis as any).__wbOnStroke = (doc: any) => {
      const cvs = canvasRef.current!;
      if (!cvs) return;
      const ctx = cvs.getContext("2d")!;
      const w = cvs.clientWidth,
        h = cvs.clientHeight;
      const pts = (doc?.points || []).map((p: any) => ({
        x: p.x * w,
        y: p.y * h,
      }));
      if (pts.length < 2) return;
      ctx.save();
      if (doc.tool === "eraser") {
        ctx.globalCompositeOperation = "destination-out";
        ctx.strokeStyle = "rgba(0,0,0,1)";
      } else {
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = doc.color || "#111";
      }
      ctx.lineWidth = Math.max(1, Number(doc.size) || 3);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.restore();
    };
  }, []);

  // canvas resize
  useEffect(() => {
    const cvs = canvasRef.current!;
    const parent = cvs.parentElement!;
    const resize = () => {
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      cvs.width = Math.floor(w * dpr);
      cvs.height = Math.floor(h * dpr);
      cvs.style.width = `${w}px`;
      cvs.style.height = `${h}px`;
      const ctx = cvs.getContext("2d")!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  const norm = useCallback((e: PointerEvent) => {
    const cvs = canvasRef.current!;
    const rect = cvs.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    return { x, y, nx: x / rect.width, ny: y / rect.height };
  }, []);

  // pointer drawing -> emit wb:stroke with a small polyline batch
  useEffect(() => {
    const cvs = canvasRef.current!;
    let batch: { x: number; y: number }[] = [];
    let flushTimer: any = null;

    let lastNorm: { x: number; y: number } | null = null;

    const flush = () => {
      if (!batch.length) return;
      const tools = (globalThis as any).__wbTools || {
        color: "#111",
        size: 3,
        erase: false,
      };
      socketRef.current?.emit("wb:stroke", {
        tool: tools.erase ? "eraser" : "pen",
        color: tools.color,
        size: tools.size,
        // send normalized points
        points: batch,
      });
      batch = lastNorm ? [lastNorm] : [];
    };

    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      cvs.setPointerCapture(e.pointerId);
      setIsDown(true);
      lastPt.current = null;

      // seed batch with the initial point so receivers start at the right spot
    const { nx, ny } = norm(e);
    lastNorm = { x: nx, y: ny };
    batch = [lastNorm];
    };

    const onUp = (e: PointerEvent) => {
      e.preventDefault();
      try {
        cvs.releasePointerCapture(e.pointerId);
      } catch {}
      setIsDown(false);
      lastPt.current = null;
      flush();
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      lastNorm = null;
      batch = [];
    };

    const onMove = (e: PointerEvent) => {
      if (!isDown) return;
      const { x, y, nx, ny } = norm(e);
      const tools = (globalThis as any).__wbTools || {
        color: "#111",
        size: 3,
        erase: false,
      };
      // draw locally for instant feedback
      if (lastPt.current) {
        const ctx = cvs.getContext("2d")!;
        ctx.save();
        if (tools.erase) {
          ctx.globalCompositeOperation = "destination-out";
          ctx.strokeStyle = "rgba(0,0,0,1)";
        } else {
          ctx.globalCompositeOperation = "source-over";
          ctx.strokeStyle = tools.color;
        }
        ctx.lineWidth = tools.size;
        ctx.beginPath();
        ctx.moveTo(lastPt.current.x, lastPt.current.y);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.restore();
      }
      lastPt.current = { x, y };
      // accumulate normalized points for this stroke

      lastNorm = { x: nx, y: ny };
      
      batch.push(lastNorm);

      // small debounce to send in short chunks
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flush();
          flushTimer = null;
        }, 50);
      }
    };

    cvs.addEventListener("pointerdown", onDown);
    cvs.addEventListener("pointerup", onUp);
    cvs.addEventListener("pointercancel", onUp);
    cvs.addEventListener("pointermove", onMove);
    return () => {
      cvs.removeEventListener("pointerdown", onDown);
      cvs.removeEventListener("pointerup", onUp);
      cvs.removeEventListener("pointercancel", onUp);
      cvs.removeEventListener("pointermove", onMove);
    };
  }, [socketRef, isDown, norm]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: "100%",
        height: "100%",
        cursor: "crosshair",
        touchAction: "none",
        background: "white",
      }}
    />
  );
}

function RequestShare({
  roomName,
  username,
  onAllowed,
}: {
  roomName: string;
  username: string;
  onAllowed: () => void;
}) {
  type Status = "idle" | "waiting" | "denied" | "allowed";
  const [status, setStatus] = useState<Status>("idle");

  // poll for status while waiting
  useEffect(() => {
    if (status !== "waiting") return;
    let t: any;

    const tick = async () => {
      try {
        const u = new URL(
          `${process.env.NEXT_PUBLIC_API_BASE}/api/participant/share-status`
        );
        u.searchParams.set("roomName", roomName);
        u.searchParams.set("identity", username);
        const r = await fetch(u.toString(), { cache: "no-store" });
        const d = await r.json();

        if (d.ok) {
          if (d.canShare) {
            setStatus("allowed");
            onAllowed();
            return;
          }
          if (!d.pending && d.decision === "denied") {
            setStatus("denied"); // <-- stop showing "waiting"
            return;
          }
        }
      } catch {}

      t = setTimeout(tick, 2000);
    };

    tick();
    return () => clearTimeout(t);
  }, [status, roomName, username, onAllowed]);

  const request = async () => {
    await fetch(
      `${process.env.NEXT_PUBLIC_API_BASE}/api/mod/screenshare/request`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomName, identity: username, name: username }),
      }
    );
    setStatus("waiting");
  };

  if (status === "allowed") return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: "calc(var(--lk-control-bar-height) + 60px)",
        left: 16,
        zIndex: 10,
      }}
    >
      {status === "idle" && (
        <button className="lk-button" onClick={request}>
          Request screen share
        </button>
      )}
      {status === "waiting" && <span>Waiting for moderator approval…</span>}
      {status === "denied" && (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span>Request denied.</span>
          <button className="lk-button" onClick={request}>
            Request again
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- Moderator Panel ----------
function ModeratorPanel({
  room,
  roomName,
  role,
}: {
  room: Room;
  roomName: string;
  role: Role;
}) {
  const [list, setList] = useState<RemoteParticipant[]>([]);
  const [requests, setRequests] = useState<
    Array<{ identity: string; name: string; at: number }>
  >([]);

  useEffect(() => {
    const resync = () => {
      const all = Array.from(room.remoteParticipants.values());
      const humans = all.filter((p: any) => {
        const k = p.kind ?? "standard";
        const isStandard = typeof k === "string" ? k === "standard" : k === 0;
        const isHidden = !!p.permissions?.hidden;
        return isStandard && !isHidden;
      });
      setList(humans);
    };
    resync();
    room.on(RoomEvent.ParticipantConnected, resync);
    room.on(RoomEvent.ParticipantDisconnected, resync);
    room.on(RoomEvent.TrackPublished, resync);
    room.on(RoomEvent.TrackUnpublished, resync);
    return () => {
      room.off(RoomEvent.ParticipantConnected, resync);
      room.off(RoomEvent.ParticipantDisconnected, resync);
      room.off(RoomEvent.TrackPublished, resync);
      room.off(RoomEvent.TrackUnpublished, resync);
    };
  }, [room]);

  // poll pending requests every 2s
  useEffect(() => {
    let t: any;
    const tick = async () => {
      try {
        const u = new URL(
          `${process.env.NEXT_PUBLIC_API_BASE}/api/mod/screenshare/pending`
        );
        u.searchParams.set("roomName", roomName);
        u.searchParams.set("role", role);
        const r = await fetch(u.toString(), { cache: "no-store" });
        const d = await r.json();
        if (d.ok) setRequests(d.items || []);
      } catch {}
      t = setTimeout(tick, 2000);
    };
    tick();
    return () => clearTimeout(t);
  }, [roomName, role]);

  async function post(path: string, body: any) {
    const resp = await fetch(`${process.env.NEXT_PUBLIC_API_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  const mute = (
    identity: string,
    kind: "audio" | "video" | "screenshare",
    mute = true
  ) => post("/api/mod/mute", { roomName, role, identity, kind, mute });

  const allowSS = (identity: string, allow: boolean) =>
    post("/api/mod/screenshare/decide", { roomName, role, identity, allow });

  return (
    <aside
      style={{ borderLeft: "1px solid #e5e5e5", padding: 12, overflow: "auto" }}
    >
      <h3>Participants</h3>
      {list.length === 0 && <p>No one else yet.</p>}
      {list.map((p) => (
        <div
          key={p.identity}
          style={{
            padding: 8,
            border: "1px solid #eee",
            borderRadius: 8,
            marginBottom: 8,
          }}
        >
          <div style={{ fontWeight: 600 }}>{p.name || p.identity}</div>
          <div
            style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}
          >
            <button
              className="lk-button"
              onClick={() => mute(p.identity, "audio", true)}
            >
              Mute mic
            </button>
            <button
              className="lk-button"
              onClick={() => mute(p.identity, "video", true)}
            >
              Turn off camera
            </button>
            <button
              className="lk-button"
              onClick={() => mute(p.identity, "screenshare", true)}
            >
              Stop screenshare
            </button>
            <button
              className="lk-button"
              onClick={() => allowSS(p.identity, true)}
            >
              Allow screenshare
            </button>
            <button
              className="lk-button lk-button-danger"
              onClick={() => allowSS(p.identity, false)}
            >
              Deny screenshare
            </button>
          </div>
        </div>
      ))}

      <h3 style={{ marginTop: 16 }}>Screen-share requests</h3>
      {requests.length === 0 && <p>No pending requests.</p>}
      {requests.map((r) => (
        <div
          key={r.identity}
          style={{
            padding: 8,
            border: "1px dashed #bbb",
            borderRadius: 8,
            marginBottom: 8,
          }}
        >
          <div>
            <b>{r.name}</b> ({r.identity})
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              className="lk-button"
              onClick={() => allowSS(r.identity, true)}
            >
              Allow
            </button>
            <button
              className="lk-button lk-button-danger"
              onClick={() => allowSS(r.identity, false)}
            >
              Deny
            </button>
          </div>
        </div>
      ))}
    </aside>
  );
}

function BreakoutsPanel({
  parentRoom,
  room,
  role,
}: {
  parentRoom: string;
  room: Room;
  role: Role;
}) {
  const [label, setLabel] = useState("");
  const [duration, setDuration] = useState<number>(10);
  const [creating, setCreating] = useState(false);

  const [state, setState] = useState<{
    main?: any;
    breakouts: Array<{ roomName: string; hls?: any; endAt?: number }>;
  }>({ breakouts: [] });

  const [sourceRoom, setSourceRoom] = useState<string>(parentRoom);
  const [participants, setParticipants] = useState<
    Array<{ identity: string; name: string }>
  >([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [now, setNow] = useState<number>(Date.now());

  // poll breakout state
  useEffect(() => {
    let t: any;
    const tick = async () => {
      try {
        const u = new URL(
          `${process.env.NEXT_PUBLIC_API_BASE}/api/breakouts/state`
        );
        u.searchParams.set("parentRoom", parentRoom);
        const r = await fetch(u.toString(), { cache: "no-store" });
        const d = await r.json();
        if (d.ok) setState({ main: d.main, breakouts: d.breakouts });
      } catch {}
      t = setTimeout(tick, 2500);
    };
    tick();
    return () => clearTimeout(t);
  }, [parentRoom]);

  // local clock for countdowns
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // load participants of selected source room
  useEffect(() => {
    let ignore = false;
    const load = async () => {
      try {
        const u = new URL(
          `${process.env.NEXT_PUBLIC_API_BASE}/api/room/participants`
        );
        u.searchParams.set("roomName", sourceRoom);
        u.searchParams.set("role", role);
        const r = await fetch(u.toString(), { cache: "no-store" });
        const d = await r.json();
        if (!ignore && d.ok) setParticipants(d.items || []);
      } catch {}
    };
    load();
    return () => {
      ignore = true;
    };
  }, [sourceRoom, role]);

  const createBreakout = async () => {
    // allow click even if label empty -> generate a fallback
    const safeLabel =
      label.trim() ||
      `group-${new Date().toISOString().slice(11, 16).replace(":", "")}`; // e.g. group-13-45

    setCreating(true);
    try {
      const resp = await fetch(
        `${process.env.NEXT_PUBLIC_API_BASE}/api/breakouts/create`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            parentRoom,
            label: safeLabel,
            role,
            durationMinutes: Number(duration) || 0,
          }),
        }
      );
      const d = await resp.json();
      if (!resp.ok) throw new Error(d.error || "Failed to create breakout");
      setLabel(""); // reset input
    } catch (e: any) {
      alert(e?.message || "Failed to create breakout");
    } finally {
      setCreating(false);
    }
  };

  const closeBreakout = async (bo: string) => {
    const resp = await fetch(
      `${process.env.NEXT_PUBLIC_API_BASE}/api/breakouts/close`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentRoom, breakout: bo, role }),
      }
    );
    const d = await resp.json();
    if (!resp.ok) alert(d.error || "Failed to close breakout");
  };

  const extendBreakout = async (bo: string, minutes = 5) => {
    const resp = await fetch(
      `${process.env.NEXT_PUBLIC_API_BASE}/api/breakouts/extend`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parentRoom,
          breakout: bo,
          role,
          addMinutes: minutes,
        }),
      }
    );
    const d = await resp.json();
    if (!resp.ok) alert(d.error || "Failed to extend breakout");
  };

  const moveTo = async (toRoom: string) => {
    for (const id of selected) {
      const resp = await fetch(
        `${process.env.NEXT_PUBLIC_API_BASE}/api/breakouts/move`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fromRoom: sourceRoom,
            identity: id,
            toRoom,
            role,
          }),
        }
      );
      const d = await resp.json();
      if (!resp.ok) alert(d.error || `Failed to move ${id}`);
    }
    setSelected([]);
  };

  const roomsList = [parentRoom, ...state.breakouts.map((b) => b.roomName)];
  const breakoutsOnly = state.breakouts.map((b) => b.roomName);

  const canMove = selected.length > 0;
  const thereAreBreakouts = breakoutsOnly.length > 0;

  return (
    <aside
      style={{ borderLeft: "1px solid #e5e5e5", padding: 12, overflow: "auto" }}
    >
      <h3>Breakouts</h3>

      <div style={{ display: "grid", gap: 8 }}>
        {/* Create */}
        <div>
          <input
            placeholder="New breakout label"
            value={label}
            className="text-black"
            onChange={(e) => setLabel(e.target.value)}
          />
          <input
            type="number"
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            min={0}
            className="border border-gray-300 rounded-md p-2 text-black"
            style={{ width: 90, marginLeft: 6 }}
            title="Duration in minutes (0 = no timer)"
          />
          <button
            className="lk-button"
            onClick={createBreakout}
            disabled={creating}
            title={
              label.trim() ? "" : "Will auto-generate a name if left blank"
            }
          >
            {creating ? "Creating…" : "Create"}
          </button>
        </div>

        {/* Move participants — only if there is somewhere to move */}
        {thereAreBreakouts && (
          <div style={{ borderTop: "1px solid #eee", paddingTop: 8 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              Move participants
            </div>

            <label className="text-black">Source room</label>
            <select
              className="text-black"
              value={sourceRoom}
              onChange={(e) => setSourceRoom(e.target.value)}
              style={{ display: "block", marginBottom: 6 }}
            >
              {roomsList.map((r) => (
                <option key={r} value={r}>
                  {r === parentRoom ? `${r} (main)` : r}
                </option>
              ))}
            </select>

            <label className="text-black">Choose participants</label>
            <select
              multiple
              value={selected}
              onChange={(e) =>
                setSelected(
                  Array.from(e.target.selectedOptions).map((o) => o.value)
                )
              }
              style={{ width: "100%", minHeight: 90, marginBottom: 8 }}
              className="text-black"
            >
              {participants.map((p) => (
                <option key={p.identity} value={p.identity}>
                  {p.name}
                </option>
              ))}
            </select>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {/* Only show Move to main when the source is NOT the main */}
              {sourceRoom !== parentRoom && (
                <button
                  className="lk-button"
                  disabled={!canMove}
                  onClick={() => moveTo(parentRoom)}
                >
                  Move to main
                </button>
              )}
              {breakoutsOnly.map(
                (bo) =>
                  // Hide the button to move to the SAME room you’re already viewing
                  bo !== sourceRoom && (
                    <button
                      key={bo}
                      className="lk-button"
                      disabled={!canMove}
                      onClick={() => moveTo(bo)}
                    >
                      Move to {breakoutLabelFromName(parentRoom, bo)}
                    </button>
                  )
              )}
            </div>
          </div>
        )}

        {/* Active list */}
        <div style={{ borderTop: "1px solid #eee", paddingTop: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            Active breakouts
          </div>
          {state.breakouts.length === 0 && <p>None</p>}
          {state.breakouts.map((b) => {
            const label = breakoutLabelFromName(parentRoom, b.roomName);
            const remaining =
              typeof b.endAt === "number" && b.endAt > now
                ? Math.max(0, Math.floor((b.endAt - now) / 1000))
                : null;
            return (
              <div
                key={b.roomName}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  padding: 6,
                  border: "1px solid #eee",
                  borderRadius: 8,
                }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{label}</div>
                  {remaining !== null && (
                    <div style={{ fontSize: 12, color: "#666" }}>
                      Auto-closes in {Math.floor(remaining / 60)}:
                      {String(remaining % 60).padStart(2, "0")}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <a
                    className="lk-button"
                    href={b.hls?.liveUrl || "#"}
                    target="_blank"
                  >
                    Open HLS
                  </a>
                  <button
                    className="lk-button"
                    onClick={() => extendBreakout(b.roomName, 5)}
                  >
                    +5 min
                  </button>
                  <button
                    className="lk-button lk-button-danger"
                    onClick={() => closeBreakout(b.roomName)}
                  >
                    Close
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

// ---------- Observer: show all streams ----------
function ObserverSelectStream({
  parentRoom,
  initialMain,
}: {
  parentRoom: string;
  initialMain: string | null;
}) {
  const [state, setState] = useState<{ main?: any; breakouts: any[] }>({
    breakouts: [],
  });
  const [selected, setSelected] = useState<string>("__main__"); // key: __main__ or actual roomName
  const [url, setUrl] = useState<string | null>(initialMain);

  useEffect(() => {
    let t: any;
    const tick = async () => {
      try {
        const u = new URL(
          `${process.env.NEXT_PUBLIC_API_BASE}/api/breakouts/state`
        );
        u.searchParams.set("parentRoom", parentRoom);
        const r = await fetch(u.toString(), { cache: "no-store" });
        const d = await r.json();
        if (d.ok) setState({ main: d.main, breakouts: d.breakouts });
      } catch {}
      t = setTimeout(tick, 3000);
    };
    tick();
    return () => clearTimeout(t);
  }, [parentRoom]);

  // update URL when selection changes or state changes
  useEffect(() => {
    if (selected === "__main__") {
      setUrl(state.main?.liveUrl || initialMain || null);
    } else {
      const bo = state.breakouts.find((b) => b.roomName === selected);
      setUrl(bo?.liveUrl || null);
    }
  }, [selected, state, initialMain]);

  const options = [
    { value: "__main__", label: `${parentRoom} (main)` },
    ...state.breakouts.map((b: any) => ({
      value: b.roomName,
      label: breakoutLabelFromName(parentRoom, b.roomName),
    })),
  ];

  return (
    <main style={{ padding: 16 }}>
      <h2>Observer</h2>
      <label style={{ display: "block", marginBottom: 6 }}>Choose a room</label>
      <select
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        style={{ marginBottom: 12 }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <HlsPlayer src={url} />
    </main>
  );
}

function breakoutLabelFromName(parent: string, full: string) {
  const prefix = `${parent}__bo__`;
  return full.startsWith(prefix) ? full.slice(prefix.length) : full;
}

// Minimal HLS player (works in Chrome/Firefox via hls.js; Safari plays HLS natively)
function HlsPlayer({ src }: { src: string | null }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (!src || !ref.current) return;
    const video = ref.current;

    const ping = async () => {
      for (let i = 0; i < 10; i++) {
        try {
          const r = await fetch(src, { method: "HEAD", cache: "no-store" });
          if (r.ok) return true;
        } catch {}
        await new Promise((r) => setTimeout(r, 1000));
      }
      return false;
    };

    (async () => {
      await ping();
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = src;
        try {
          await video.play();
        } catch {}
        return;
      }
      if (Hls.isSupported()) {
        const hls = new Hls({
          liveDurationInfinity: true,
          // smoother live edge tracking:
          liveSyncDurationCount: 3,
          maxLiveSyncPlaybackRate: 1.2,
        });
        hls.loadSource(src);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_e, data) => {
          // simple recoverables
          if (data.fatal) {
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR)
              hls.recoverMediaError();
          }
        });
        try {
          await video.play();
        } catch {}
        return () => hls.destroy();
      }
    })();
  }, [src]);

  return (
    <video
      ref={ref}
      controls
      playsInline
      autoPlay
      muted
      style={{ width: "100%", maxWidth: 960 }}
    />
  );
}
