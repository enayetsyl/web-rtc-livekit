'use client';
import { useEffect, useState } from 'react';
// add RoomEvent & DisconnectReason
import { Room, Track, RoomEvent, DisconnectReason } from 'livekit-client';
import {
  RoomContext, GridLayout, ParticipantTile, ControlBar, RoomAudioRenderer, useTracks
} from '@livekit/components-react';
import '@livekit/components-styles';

export default function Page() {
  const [roomName, setRoomName] = useState('');
  const [username, setUsername] = useState('');
  const [connected, setConnected] = useState(false);
  const [isHost, setIsHost] = useState(false);
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

    // attach a reason-aware listener once connected
    room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      if (reason === DisconnectReason.ROOM_DELETED) {
        alert('Meeting ended by host.');
      }
      setConnected(false);
    });

    setIsHost(kind === 'start'); // show End button only for the starter
    setConnected(true);
  }

  async function endMeeting() {
    await fetch(`${process.env.NEXT_PUBLIC_API_BASE}/api/meeting/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomName }),
    });
    // local user also leaves immediately
    room.disconnect();
    setConnected(false);
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
console.log('host', isHost)
  return (
    <RoomContext.Provider value={room}>
    <div data-lk-theme="default" style={{ height: '100dvh' }}>
      <MyVideoConference />
      <RoomAudioRenderer />
  
      {/* Remove your old button row */}
  
      {/* Float the host-only end button above the ControlBar */}
      {isHost && (
        <div
          style={{
            position: 'fixed',
            bottom: 'calc(var(--lk-control-bar-height) + 12px)', // sits just above the bar
            right: 16,
            zIndex: 10,
          }}
        >
          <button className="lk-button lk-button-danger" onClick={endMeeting}>
            End meeting (host)
          </button>
        </div>
      )}
  
      {/* Keep the built-in ControlBar */}
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
