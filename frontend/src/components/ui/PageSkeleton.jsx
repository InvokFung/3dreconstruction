export default function PageSkeleton() {
  return (
    <div className="container" style={{ paddingBlock: 'var(--space-7)' }} aria-busy="true" aria-label="Loading">
      <div className="skeleton" style={{ width: 120, height: 14, marginBottom: 16 }} />
      <div className="skeleton" style={{ width: 'min(420px, 80%)', height: 38, marginBottom: 32 }} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 20 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton" style={{ height: 240, borderRadius: 14 }} />
        ))}
      </div>
    </div>
  );
}
