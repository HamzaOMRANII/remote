import Background from '../components/Background.jsx';
import TopBar from '../components/TopBar.jsx';
import DeviceCard from '../components/DeviceCard.jsx';
import { useRemote } from '../ws.js';

export default function Devices({ me }) {
  const { connected, devices, action } = useRemote();

  return (
    <>
      <Background />
      <TopBar me={me} connected={connected} />
      <main className="wrap">
        <div>
          <h1 style={{ fontFamily: 'var(--font-mark)', fontSize: 24, margin: 0 }}>
            Devices <span className="h2-sub muted">{devices.length} online</span>
          </h1>
          <p className="rem-sub" style={{ marginTop: 6 }}>Your devices and what each one can do.</p>
        </div>

        {devices.length === 0 ? (
          <div className="empty-wrap">
            <span className={`conn`}><span className={`live-dot ${connected ? '' : 'off'}`} />
              {connected ? 'Connected — waiting for a device' : 'Connecting…'}</span>
            <h2>No devices online</h2>
            <p className="muted">Start the agent on a device and it will appear here. In M1 that's the
              Raspberry Pi advertising its GPIO pins.</p>
          </div>
        ) : (
          <div className="srv-grid">
            {devices.map((d) => <DeviceCard key={d.id} device={d} action={action} />)}
          </div>
        )}
      </main>
    </>
  );
}
