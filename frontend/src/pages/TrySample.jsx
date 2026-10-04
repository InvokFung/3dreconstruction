import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/index.js';
import Icon from '../components/ui/Icon.jsx';

/** Creates a project from a sample and forwards to it (used as a post-login destination). */
export default function TrySample() {
  const { sample } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api.samples
      .createProject(sample)
      .then((project) => navigate(`/projects/${project.id}`, { replace: true }))
      .catch((err) => setError(err.message));
  }, [sample, navigate]);

  return (
    <div className="container" style={{ paddingBlock: 'var(--space-8)' }}>
      <div className="empty" role="status">
        {error ? (
          <>
            <Icon name="alert" />
            <h1 style={{ fontSize: '1.5rem' }}>Couldn’t open that sample</h1>
            <p>{error}</p>
            <Link className="btn" to="/" state={{ scrollTo: 'samples' }}>
              Back to samples
            </Link>
          </>
        ) : (
          <>
            <span className="spinner" aria-hidden="true" style={{ width: 28, height: 28, color: 'var(--accent)' }} />
            <p>Preparing the “{sample}” sample project…</p>
          </>
        )}
      </div>
    </div>
  );
}
