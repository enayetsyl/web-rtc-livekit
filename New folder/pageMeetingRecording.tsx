'use client';
import { useEffect, useState } from 'react';
import { Room, Track, RoomEvent, DisconnectReason } from 'livekit-client';
import { RoomContext, GridLayout, ParticipantTile, ControlBar, RoomAudioRenderer, useTracks } from '@livekit/components-react';
import '@livekit/components-styles';

export default function Page() {
  const [roomName, setRoomName] = useState('');
  const [username, setUsername] = useState('');
  const [connected, setConnected] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [recording, setRecording] = useState(false);
  const [egressId, setEgressId] = useState<string | null>(null);
  const [room] = useState(() => new Room({ adaptiveStream: true, dynacast: true }));

  useEffect(() => () => room.disconnect(), [room]);

  async function startOrJoin(kind: 'start' | 'join') {
    const resp = await fetch(`${process.env.NEXT_PUBLIC_API_BASE}/api/meeting/${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomName, username }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Request failed');

    await room.connect(data.wsUrl || process.env.NEXT_PUBLIC_LIVEKIT_URL!, data.token);

    room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      if (reason === DisconnectReason.ROOM_DELETED) alert('Meeting ended by host.');
      setConnected(false);
      setRecording(false);
      setEgressId(null);
    });

    setIsHost(kind === 'start');
    setConnected(true);
  }

  async function endMeeting() {
    await fetch(`${process.env.NEXT_PUBLIC_API_BASE}/api/meeting/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomName }),
    });
    room.disconnect();
    setConnected(false);
    setRecording(false);
    setEgressId(null);
  }

  // --- recording buttons ---
  async function startRecording() {
    const resp = await fetch(`${process.env.NEXT_PUBLIC_API_BASE}/api/record/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomName, layout: 'grid' }), // 'grid' | 'speaker' | 'single-speaker' | 'grid-light'
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
      body: JSON.stringify({ egressId, roomName }),
    });
    setRecording(false);
    setEgressId(null);
  }

  if (!connected) {
    return (
      <main style={{ padding: 24, maxWidth: 520 }}>
        <h1>LiveKit Meeting</h1>
        <input placeholder="Room name" value={roomName} onChange={e => setRoomName(e.target.value)} />
        <input placeholder="Your name" value={username} onChange={e => setUsername(e.target.value)} />
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button onClick={() => startOrJoin('start')}>Start meeting</button>
          <button onClick={() => startOrJoin('join')}>Join meeting</button>
        </div>
      </main>
    );
  }

  return (
    <RoomContext.Provider value={room}>
      <div data-lk-theme="default" style={{ height: '100dvh' }}>
        <MyVideoConference />
        <RoomAudioRenderer />

        {/* Host tools above the ControlBar */}
        {isHost && (
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
            <button className="lk-button lk-button-danger" onClick={endMeeting}>End meeting (host)</button>
          </div>
        )}

        <ControlBar />
      </div>
    </RoomContext.Provider>
  );
}

function MyVideoConference() {
  const tracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }, { source: Track.Source.ScreenShare, withPlaceholder: true }],
    { onlySubscribed: false },
  );
  return (
    <GridLayout tracks={tracks} style={{ height: 'calc(100vh - var(--lk-control-bar-height))' }}>
      <ParticipantTile />
    </GridLayout>
  );
}
