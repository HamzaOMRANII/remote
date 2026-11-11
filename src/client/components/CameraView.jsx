import { useEffect, useRef, useState } from 'react';

// Viewer side of the camera (WebRTC consumer). Sends a `request` to the device
// agent, which replies with an offer + its camera track; we answer and show the
// stream. The device agent is the browser page at /connect on that device.
// A device can offer several cameras (cap.cameras, M7c: a phone relaying the owner's IP cameras): the viewer
// picks one, and every signal names it so the device can run one connection per camera.
export default function CameraView({ device, cap = {}, action, sendSignal, onSignal }) {
  const cameras = Array.isArray(cap.cameras) ? cap.cameras : [];
  const [camera, setCamera] = useState(cameras[0]?.id || '');
  const camRef = useRef(camera);
  camRef.current = camera;
  const videoRef = useRef(null);
  const pcRef = useRef(null);
  const current = cameras.find((c) => c.id === camera);
  const [recBusy, setRecBusy] = useState(false);
  async function toggleRecord() {
    setRecBusy(true); setErr('');
    try { await action(device, 'camera', 'record', { camera, on: !current.recording }); }
    catch (e) { setErr(e.message); } finally { setRecBusy(false); }
  }
  const send = (data) => sendSignal(device, camRef.current ? { ...data, camera: camRef.current } : data);
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
    pc.onicecandidate = (ev) => { if (ev.candidate) send({ kind: 'ice', candidate: ev.candidate }); };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'disconnected') { setErr('connection lost'); setStatus('error'); }
    };

    // ask the device to start its camera and send us an offer
    send({ kind: 'request' });
  }

  useEffect(() => {
    const off = onSignal(device, async (data) => {
      const pc = pcRef.current;
      if (!pc) return;
      // replies for another camera of the same device (another tile, or the camera we just left)
      if (camRef.current && (data.camera || 'phone') !== camRef.current) return;
      try {
        if (data.kind === 'offer') {
          await pc.setRemoteDescription(data.sdp);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          send({ kind: 'answer', sdp: pc.localDescription });
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
      {cameras.length > 1 && (
        <div className="seg cam-pick" role="group" aria-label="Which camera">
          {cameras.map((c) => (
            <button key={c.id} type="button" className={c.id === camera ? 'on' : ''}
              onClick={() => { if (c.id !== camera) { stop(); setCamera(c.id); } }}>{c.name || c.id}</button>
          ))}
        </div>
      )}
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
        {current && current.record && action && (
          <button className={`rec-btn ${current.recording ? 'on' : ''}`} disabled={recBusy} onClick={toggleRecord}
            title="Recorded on the phone at home (Gallery › Movies › Remote), never on the server">
            <span className="rec-dot" />{current.recording ? 'Stop recording' : 'Record'}</button>
        )}
      </div>
      {err && <div className="ctl-note err">{err}</div>}
    </div>
  );
}
