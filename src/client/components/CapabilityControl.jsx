import { useState } from 'react';

// Renders the controls for one capability on one device. M1 wires `gpio`
// (digital switch + PWM/servo slider); the other capabilities are advertised
// but land in later milestones.

function Note({ note }) {
  if (!note) return <div className="ctl-note" />;
  return <div className={`ctl-note ${note.ok ? 'ok' : 'err'}`}>{note.text}</div>;
}

function DigitalPin({ device, pin, action }) {
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  async function toggle(e) {
    const next = e.target.checked;
    setOn(next); setBusy(true); setNote(null);
    try {
      await action(device, 'gpio', 'set', { pin: pin.id, value: next });
      setNote({ ok: true, text: next ? 'on' : 'off' });
    } catch (err) {
      setOn(!next); // revert on failure
      setNote({ ok: false, text: err.message });
    } finally { setBusy(false); }
  }

  return (
    <div>
      <div className="ctl-row">
        <span className="ctl-label">{pin.label || `Pin ${pin.id}`}<span className="ctl-pin">GPIO {pin.id}</span></span>
        <label className="switch">
          <input type="checkbox" checked={on} disabled={busy} onChange={toggle} aria-label={pin.label || `Pin ${pin.id}`} />
          <span className="track" /><span className="knob" />
        </label>
      </div>
      <Note note={note} />
    </div>
  );
}

function ServoPin({ device, pin, action }) {
  const min = pin.min_angle ?? -90;
  const max = pin.max_angle ?? 90;
  const [angle, setAngle] = useState(Math.round((min + max) / 2));
  const [note, setNote] = useState(null);

  async function commit(val) {
    setNote(null);
    try {
      await action(device, 'gpio', 'set', { pin: pin.id, value: Number(val) });
      setNote({ ok: true, text: `${val}°` });
    } catch (err) {
      setNote({ ok: false, text: err.message });
    }
  }

  return (
    <div className="servo">
      <div className="servo-top">
        <span className="ctl-label">{pin.label || `Pin ${pin.id}`}<span className="ctl-pin">GPIO {pin.id}</span></span>
        <span className="servo-val">{angle}°</span>
      </div>
      <input
        type="range" className="slider" min={min} max={max} value={angle}
        onChange={(e) => setAngle(Number(e.target.value))}
        onMouseUp={(e) => commit(e.target.value)}
        onTouchEnd={(e) => commit(e.target.value)}
        onKeyUp={(e) => commit(e.target.value)}
        aria-label={pin.label || `Pin ${pin.id}`}
      />
      <Note note={note} />
    </div>
  );
}

export default function CapabilityControl({ device, cap, action }) {
  if (cap.cap === 'gpio') {
    const pins = cap.pins || [];
    return (
      <div className="cap-block">
        <div className="cap-head">GPIO</div>
        <div className="dev-caps">
          {pins.length === 0 && <span className="muted">No pins configured.</span>}
          {pins.map((p) =>
            p.kind === 'pwm'
              ? <ServoPin key={p.id} device={device} pin={p} action={action} />
              : <DigitalPin key={p.id} device={device} pin={p} action={action} />
          )}
        </div>
      </div>
    );
  }

  // advertised but not yet wired
  const labels = { camera: 'Camera', scripts: 'Scripts', shell: 'Shell', media: 'Media' };
  const next = { camera: 'M2', scripts: 'M3', shell: 'M3', media: 'M6' };
  return (
    <div className="cap-block">
      <div className="cap-head">{labels[cap.cap] || cap.cap}</div>
      <span className="muted rem-sub">Advertised · wired in {next[cap.cap] || 'a later milestone'}.</span>
    </div>
  );
}
