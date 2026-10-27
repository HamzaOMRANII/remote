import CapabilityControl from './CapabilityControl.jsx';

// One card per device — same .card / .srv-head vocabulary as monitoring's
// server cards. Shows identity, online status, and a control block per capability.
export default function DeviceCard({ device, action }) {
  return (
    <section className="card card-static">
      <div className="srv-head">
        <div>
          <div className="card-name">{device.name}</div>
          <div className="card-meta">{device.platform} · {device.id}</div>
        </div>
        <span className={`status ${device.online ? 'status-live' : 'status-planned'}`}>
          {device.online ? 'online' : 'offline'}
        </span>
      </div>
      <div className="dev-caps">
        {device.capabilities.map((cap) => (
          <CapabilityControl key={cap.cap} device={device.id} cap={cap} action={action} />
        ))}
      </div>
    </section>
  );
}
