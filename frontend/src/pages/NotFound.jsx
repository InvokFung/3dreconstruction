import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="container" style={{ paddingBlock: 'var(--space-8)' }}>
      <div className="empty">
        <svg viewBox="0 0 120 80" aria-hidden="true">
          <g fill="currentColor" opacity=".55">
            {Array.from({ length: 40 }, (_, i) => (
              <circle key={i} cx={10 + ((i * 37) % 100)} cy={10 + ((i * 23) % 60)} r={1.4 + (i % 3) * 0.5} />
            ))}
          </g>
        </svg>
        <span className="eyebrow">404 · no points here</span>
        <h1 style={{ fontSize: '2rem' }}>This page didn’t reconstruct.</h1>
        <p>The link may be broken, or the project was deleted.</p>
        <div className="row" style={{ justifyContent: 'center' }}>
          <Link to="/" className="btn">
            Home
          </Link>
          <Link to="/projects" className="btn btn--primary">
            Your projects
          </Link>
        </div>
      </div>
    </div>
  );
}
