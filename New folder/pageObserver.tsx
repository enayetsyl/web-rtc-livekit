'use client';
import { useEffect, useRef, useState } from 'react';
import { Room, Track, RoomEvent, DisconnectReason } from 'livekit-client';
import {
  RoomContext, GridLayout, ParticipantTile, ControlBar, RoomAudioRenderer, useTracks
} from '@livekit/components-react';
import '@livekit/components-styles';
import Hls from 'hls.js';

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

        <ControlBar />
      </div>
    </RoomContext.Provider>
  );
}

function MyVideoConference() {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: true },
    ],
    { onlySubscribed: false },
  );
  return (
    <GridLayout tracks={tracks} style={{ height: 'calc(100vh - var(--lk-control-bar-height))' }}>
      <ParticipantTile />
    </GridLayout>
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
