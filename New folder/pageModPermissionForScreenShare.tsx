'use client';
import { useEffect, useRef, useState } from 'react';
import { Room, Track, RoomEvent, DisconnectReason } from 'livekit-client';
import {
  RoomContext, GridLayout, ParticipantTile, ControlBar, RoomAudioRenderer, useTracks
} from '@livekit/components-react';
import '@livekit/components-styles';
import Hls from 'hls.js';
import type { RemoteParticipant } from 'livekit-client';

type Role = 'admin' | 'moderator' | 'participant' | 'observer';

export default function Page() {
  const [roomName, setRoomName] = useState('');
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<Role>('participant');

  const [connected, setConnected] = useState(false);
  const [hlsLiveUrl, setHlsLiveUrl] = useState<string | null>(null);
  const [room] = useState(() => new Room({ adaptiveStream: true, dynacast: true }));

  const isAdminish = role === 'admin' || role === 'moderator';

  useEffect(() => () => room.disconnect(), [room]);

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
    const onPerms = (_prev, participant) => {
      if (!participant.isLocal) return;
      const sources = participant.permissions?.canPublishSources ?? [];
      const allowed =
        sources.includes(Track.Source.ScreenShare) ||
        sources.includes(Track.Source.ScreenShareAudio);
      if (!allowed) stopLocalShare();
    };
  
    // 2) If the server mutes our screenshare publication, shut down capture locally.
    const onMuted = (publication, participant) => {
      if (!participant.isLocal) return;
      if (
        publication?.source === Track.Source.ScreenShare ||
        publication?.source === Track.Source.ScreenShareAudio
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
  
  async function startOrJoin(kind: 'start' | 'join') {
    const resp = await fetch(`${process.env.NEXT_PUBLIC_API_BASE}/api/meeting/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomName, username, role }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Request failed');

    // sync role if server modified it
    if (data.role) setRole(data.role);
    if (data.hls?.liveUrl) setHlsLiveUrl(data.hls.liveUrl);

    if (role === 'observer') {
      // Observers do not connect to LiveKit; they will just view HLS
      setConnected(true);
      return;
    }

    await room.connect(data.wsUrl || process.env.NEXT_PUBLIC_LIVEKIT_URL!, data.token);

    room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      if (reason === DisconnectReason.ROOM_DELETED) alert('Meeting ended by host.');
      setConnected(false);
      setHlsLiveUrl(null);
    });

    setConnected(true);
  }

  async function endMeeting() {
    await fetch(`${process.env.NEXT_PUBLIC_API_BASE}/api/meeting/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomName, role }),
    });
    room.disconnect();
    setConnected(false);
    setHlsLiveUrl(null);
  }

  if (!connected) {
    return (
      <main style={{ padding: 24, maxWidth: 520 }}>
        <h1>LiveKit Meeting (with HLS observers)</h1>

        <label style={{ display: 'block', marginBottom: 4 }}>Role</label>
        <select value={role} onChange={(e) => setRole(e.target.value as Role)} style={{ marginBottom: 12 }}>
          <option value="admin">admin</option>
          <option value="moderator">moderator</option>
          <option value="participant">participant</option>
          <option value="observer">observer (HLS view-only)</option>
        </select>

        <input placeholder="Room name" value={roomName} onChange={e => setRoomName(e.target.value)} />
        <input placeholder="Your name" value={username} onChange={e => setUsername(e.target.value)} />

        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button onClick={() => startOrJoin('start')} disabled={!isAdminish}>
            Start meeting (admin/mod)
          </button>
          <button onClick={() => startOrJoin('join')}>Join</button>
        </div>

        <p style={{ marginTop: 8, color: '#666' }}>
          Admin/moderator can start/end. Participants join as normal. Observers don’t appear in the grid and watch the HLS stream.
        </p>
      </main>
    );
  }

  // OBSERVER VIEW: HLS player only (no LiveKit connection)
  if (role === 'observer') {
    return (
      <main style={{ padding: 24 }}>
        <h2>Watching: {roomName}</h2>
        <HlsPlayer src={hlsLiveUrl} />
        <div style={{ marginTop: 12 }}>
          <button onClick={() => { setConnected(false); setHlsLiveUrl(null); }}>Leave</button>
        </div>
      </main>
    );
  }

  // PARTICIPANT / ADMIN / MODERATOR VIEW: LiveKit grid
  return (
    <RoomContext.Provider value={room}>
      <div data-lk-theme="default" style={{ height: '100dvh' }}>
        <MyVideoConference />
        <RoomAudioRenderer />

        {/* Admin/mod can end meeting; no recording buttons */}
        {isAdminish && (
          <div
            style={{
              position: 'fixed',
              bottom: 'calc(var(--lk-control-bar-height) + 12px)',
              right: 16,
              zIndex: 10,
            }}
          >
            <button className="lk-button lk-button-danger" onClick={endMeeting}>End meeting</button>
          </div>
        )}
{isAdminish && <ModeratorPanel room={room} roomName={roomName} role={role} />}
{role === 'participant' && (
  <RequestShare
    roomName={roomName}
    username={username}
    onAllowed={() => alert('Moderator allowed screen share. Use the Screen Share button to start.')}
  />
)}
        <ControlBar />
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
    <GridLayout tracks={tracks} style={{ height: 'calc(100vh - var(--lk-control-bar-height))' }}>
      <ParticipantTile />
    </GridLayout>
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
  type Status = 'idle' | 'waiting' | 'denied' | 'allowed';
  const [status, setStatus] = useState<Status>('idle');

  // poll for status while waiting
  useEffect(() => {
    if (status !== 'waiting') return;
    let t: any;

    const tick = async () => {
      try {
        const u = new URL(`${process.env.NEXT_PUBLIC_API_BASE}/api/participant/share-status`);
        u.searchParams.set('roomName', roomName);
        u.searchParams.set('identity', username);
        const r = await fetch(u.toString(), { cache: 'no-store' });
        const d = await r.json();

        if (d.ok) {
          if (d.canShare) {
            setStatus('allowed');
            onAllowed();
            return;
          }
          if (!d.pending && d.decision === 'denied') {
            setStatus('denied'); // <-- stop showing "waiting"
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
    await fetch(`${process.env.NEXT_PUBLIC_API_BASE}/api/mod/screenshare/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomName, identity: username, name: username }),
    });
    setStatus('waiting');
  };

  if (status === 'allowed') return null;

  return (
    <div style={{ position: 'fixed', bottom: 'calc(var(--lk-control-bar-height) + 60px)', left: 16, zIndex: 10 }}>
      {status === 'idle' && <button className="lk-button" onClick={request}>Request screen share</button>}
      {status === 'waiting' && <span>Waiting for moderator approval…</span>}
      {status === 'denied' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span>Request denied.</span>
          <button className="lk-button" onClick={request}>Request again</button>
        </div>
      )}
    </div>
  );
}


// ---------- Moderator Panel ----------
function ModeratorPanel({ room, roomName, role }: { room: Room; roomName: string; role: Role }) {
  const [list, setList] = useState<RemoteParticipant[]>([]);
  const [requests, setRequests] = useState<Array<{ identity: string; name: string; at: number }>>([]);

  useEffect(() => {
    const resync = () => setList(Array.from(room.remoteParticipants.values()));
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
        const u = new URL(`${process.env.NEXT_PUBLIC_API_BASE}/api/mod/screenshare/pending`);
        u.searchParams.set('roomName', roomName);
        u.searchParams.set('role', role);
        const r = await fetch(u.toString(), { cache: 'no-store' });
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
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  const mute = (identity: string, kind: 'audio' | 'video' | 'screenshare', mute = true) =>
    post('/api/mod/mute', { roomName, role, identity, kind, mute });

  const allowSS = (identity: string, allow: boolean) =>
    post('/api/mod/screenshare/decide', { roomName, role, identity, allow });

  return (
    <aside style={{ borderLeft: '1px solid #e5e5e5', padding: 12, overflow: 'auto' }}>
      <h3>Participants</h3>
      {list.length === 0 && <p>No one else yet.</p>}
      {list.map((p) => (
        <div key={p.identity} style={{ padding: 8, border: '1px solid #eee', borderRadius: 8, marginBottom: 8 }}>
          <div style={{ fontWeight: 600 }}>{p.name || p.identity}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button className="lk-button" onClick={() => mute(p.identity, 'audio', true)}>Mute mic</button>
            <button className="lk-button" onClick={() => mute(p.identity, 'video', true)}>Turn off camera</button>
            <button className="lk-button" onClick={() => mute(p.identity, 'screenshare', true)}>Stop screenshare</button>
            <button className="lk-button" onClick={() => allowSS(p.identity, true)}>Allow screenshare</button>
            <button className="lk-button lk-button-danger" onClick={() => allowSS(p.identity, false)}>Deny screenshare</button>
          </div>
        </div>
      ))}

      <h3 style={{ marginTop: 16 }}>Screen-share requests</h3>
      {requests.length === 0 && <p>No pending requests.</p>}
      {requests.map((r) => (
        <div key={r.identity} style={{ padding: 8, border: '1px dashed #bbb', borderRadius: 8, marginBottom: 8 }}>
          <div><b>{r.name}</b> ({r.identity})</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="lk-button" onClick={() => allowSS(r.identity, true)}>Allow</button>
            <button className="lk-button lk-button-danger" onClick={() => allowSS(r.identity, false)}>Deny</button>
          </div>
        </div>
      ))}
    </aside>
  );
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
             const r = await fetch(src, { method: 'HEAD', cache: 'no-store' });
             if (r.ok) return true;
           } catch {}
           await new Promise(r => setTimeout(r, 1000));
           }
           return false;
         };

         (async () => {
              await ping();
                if (video.canPlayType('application/vnd.apple.mpegurl')) {
                  video.src = src;
                  try { await video.play(); } catch {}
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
                     if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
                   }
                 });
                  try { await video.play(); } catch {}
                 return () => hls.destroy();
                }
              })();
            }, [src]);
          
  return <video ref={ref} controls playsInline autoPlay muted style={{ width: '100%', maxWidth: 960 }} />;
          }
