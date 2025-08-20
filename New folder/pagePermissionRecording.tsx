'use client';
import { useEffect, useState } from 'react';
import { Room, Track, RoomEvent, DisconnectReason } from 'livekit-client';
import { RoomContext, GridLayout, ParticipantTile, ControlBar, RoomAudioRenderer, useTracks } from '@livekit/components-react';
import '@livekit/components-styles';

type Role = 'admin' | 'moderator' | 'participant' | 'observer';

export default function Page() {
  const [roomName, setRoomName] = useState('');
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<Role>('participant');

  const [connected, setConnected] = useState(false);
  const [recording, setRecording] = useState(false);
  const [egressId, setEgressId] = useState<string | null>(null);

  const [room] = useState(() => new Room({ adaptiveStream: true, dynacast: true }));

  const canAdminish = role === 'admin' || role === 'moderator';

  useEffect(() => () => room.disconnect(), [room]);

  async function startOrJoin(kind: 'start' | 'join') {
    const resp = await fetch(`${process.env.NEXT_PUBLIC_API_BASE}/api/meeting/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomName, username, role }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Request failed');

    // sync role from server (in case you enforce or override)
    if (data.role) setRole(data.role);

    await room.connect(data.wsUrl || process.env.NEXT_PUBLIC_LIVEKIT_URL!, data.token);

    room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      if (reason === DisconnectReason.ROOM_DELETED) alert('Meeting ended by host.');
      setConnected(false);
      setRecording(false);
      setEgressId(null);
    });

    // auto-record status (when host starts)
    if (kind === 'start' && data.egressId) {
      setEgressId(data.egressId);
      setRecording(true);
    }

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
    setRecording(false);
    setEgressId(null);
  }

  // optional manual recording controls (admin/moderator only)
  async function startRecording() {
    const resp = await fetch(`${process.env.NEXT_PUBLIC_API_BASE}/api/record/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomName, role, layout: 'grid' }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to start recording');
    setEgressId(data.egressId);
    setRecording(true);
  }

  async function stopRecording() {
    if (!egressId) return;
    await fetch(`${process.env.NEXT_PUBLIC_API_BASE}/api/record/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ egressId, roomName, role }),
    });
    setRecording(false);
    setEgressId(null);
  }

  if (!connected) {
    return (
      <main style={{ padding: 24, maxWidth: 520 }}>
        <h1>LiveKit Meeting</h1>

        <label style={{ display: 'block', marginBottom: 4 }}>Role</label>
        <select value={role} onChange={(e) => setRole(e.target.value as Role)} style={{ marginBottom: 12 }}>
          <option value="admin">admin</option>
          <option value="moderator">moderator</option>
          <option value="participant">participant</option>
          <option value="observer">observer (view only)</option>
        </select>

        <input placeholder="Room name" value={roomName} onChange={e => setRoomName(e.target.value)} />
        <input placeholder="Your name" value={username} onChange={e => setUsername(e.target.value)} />

        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button onClick={() => startOrJoin('start')} disabled={! (role === 'admin' || role === 'moderator')}>
            Start meeting
          </button>
          <button onClick={() => startOrJoin('join')}>Join meeting</button>
        </div>
        <p style={{ marginTop: 8, color: '#666' }}>
          Only <b>admin/moderator</b> can start/end/record. Participants & observers can only join.
        </p>
      </main>
    );
  }

  return (
    <RoomContext.Provider value={room}>
      <div data-lk-theme="default" style={{ height: '100dvh' }}>
        <MyVideoConference />
        <RoomAudioRenderer />

        {/* Admin/mod tools above the ControlBar */}
        {canAdminish && (
          <div
            style={{
              position: 'fixed',
              bottom: 'calc(var(--lk-control-bar-height) + 12px)',
              right: 16,
              zIndex: 10,
              display: 'flex',
              gap: 8,
            }}
          >
            {!recording ? (
              <button className="lk-button" onClick={startRecording}>Start recording</button>
            ) : (
              <button className="lk-button lk-button-danger" onClick={stopRecording}>Stop recording</button>
            )}
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
