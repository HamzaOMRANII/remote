// Ambient background — same petrol/blue orbs + noise as server_monitoring /
// it.omranisystems.com, so the family reads as one.
export default function Background() {
  return (
    <div className="bg-field" aria-hidden="true">
      <div className="orb orb-a" />
      <div className="orb orb-b" />
      <div className="noise" />
    </div>
  );
}
