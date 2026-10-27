import { useEffect, useRef, useState } from 'react';

// Viewer side of the camera (WebRTC consumer). Sends a `request` to the device
// agent, which replies with an offer + its camera track; we answer and show the
// stream. The device agent is the browser page at /connect on that device.
export default function CameraView({ device, sendSignal, onSignal }) {
  const videoRef = useRef(null);
  const pcRef = useRef(null);
  const [status, setStatus] = useState('idle'); // idle | connecting | live | error
  const [err, setErr] = useState('');

  function stop() {
    if (pcRef.current) { try { pcRef.current.close(); } catch {} pcRef.current = null; }
    if (videoRef.current) videoRef.current.srcObject = null;
    setStatus('idle');
  }

  async function start() {
    setErr(''); setStatus('connecting');
    let ice = [{ urls: 'stun:stun.l.google.com:19302' }];
    try { const r = await fetch('/api/ice'); if (r.ok) ice = (await r.json()).iceServers || ice; } catch {}

    const pc = new RTCPeerConnection({ iceServers: ice });
    pcRef.current = pc;

    pc.ontrack = (ev) => {
      if (videoRef.current) { videoRef.current.srcObject = ev.streams[0]; setStatus('live'); }
    };
    pc.onicecandidate = (ev) => { if (ev.candidate) sendSignal(device, { kind: 'ice', candidate: ev.candidate }); };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'disconnected') { setErr('connection lost'); setStatus('error'); }
    };

    // ask the device to start its camera and send us an offer
    sendSignal(device, { kind: 'request' });
  }

  useEffect(() => {
    const off = onSignal(device, async (data) => {
      const pc = pcRef.current;
      if (!pc) return;
      try {
        if (data.kind === 'offer') {
          await pc.setRemoteDescription(data.sdp);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendSignal(device, { kind: 'answer', sdp: pc.localDescription });
        } else if (data.kind === 'ice' && data.candidate) {
          await pc.addIceCandidate(data.candidate);
        } else if (data.kind === 'error') {
          setErr(data.error || 'device error'); setStatus('error');
        }
      } catch (e) { setErr(e.message); setStatus('error'); }
    });
    return () => { off(); stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device]);

  return (
    <div className="cap-block">
      <div className="cap-head">Camera</div>
      <div className="cam-pane">
        <video ref={videoRef} autoPlay playsInline />
        {status !== 'live' && (
          <div className="cam-overlay">
            <span className="conn"><span className={`live-dot ${status === 'connecting' ? '' : 'off'}`} />
              {status === 'connecting' ? 'connecting…' : status === 'error' ? 'not connected' : 'camera off'}</span>
          </div>
        )}
        {status === 'live' && <span className="cam-badge"><span className="live-dot" />live</span>}
      </div>
      <div className="action-btns" style={{ marginTop: 10 }}>
        {status === 'idle' || status === 'error'
          ? <button onClick={start}>Start camera</button>
          : <button className="secondary" onClick={stop}>Stop</button>}
      </div>
      {err && <div className="ctl-note err">{err}</div>}
    </div>
  );
}
