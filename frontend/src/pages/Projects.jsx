import { useEffect, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/index.js';
import { formatDate, relativeTime } from '../lib/format.js';
import { useToast } from '../hooks/toast.jsx';
import Dialog, { ConfirmDialog } from '../components/ui/Dialog.jsx';
import Icon from '../components/ui/Icon.jsx';
import StatusBadge from '../components/ui/StatusBadge.jsx';
import styles from './Projects.module.css';

function NewProjectDialog({ open, onClose, onCreated }) {
  const id = useId();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const project = await api.projects.create({ name: name.trim(), description: description.trim() || undefined });
      onCreated(project);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} title="New project">
      <form className="stack" onSubmit={submit}>
        {error && (
          <div className="callout callout--danger" role="alert">
            <Icon name="alert" />
            <span>{error}</span>
          </div>
        )}
        <div className="field">
          <label className="label" htmlFor={`${id}-name`}>
            Name
          </label>
          <input
            id={`${id}-name`}
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Ceramic mug"
            required
            maxLength={120}
            autoFocus
          />
        </div>
        <div className="field">
          <label className="label" htmlFor={`${id}-desc`}>
            Description <span className="muted">(optional)</span>
          </label>
          <textarea id={`${id}-desc`} className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </div>
        <div className="dialog__actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy || !name.trim()}>
            {busy && <span className="spinner" aria-hidden="true" />}
            Create project
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ProjectCard({ project, onDelete }) {
  const thumb = api.assetUrl(project.thumbnail_url);
  return (
    <article className={`card ${styles.card}`}>
      <Link to={`/projects/${project.id}`} className={styles.cardLink} aria-label={`Open ${project.name}`}>
        <div className={styles.thumb}>
          {thumb ? (
            <img src={thumb} alt="" loading="lazy" />
          ) : (
            <div className={styles.thumbEmpty}>
              <Icon name="camera" />
            </div>
          )}
          <span className={styles.badgePos}>
            <StatusBadge status={project.status} />
          </span>
        </div>
      </Link>
      <div className={styles.body}>
        <div className={styles.titleRow}>
          <h3 className={styles.name}>
            <Link to={`/projects/${project.id}`}>{project.name}</Link>
          </h3>
          <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={() => onDelete(project)} aria-label={`Delete ${project.name}`}>
            <Icon name="trash" />
          </button>
        </div>
        {project.description && <p className={`small muted ${styles.desc}`}>{project.description}</p>}
        <p className={`mono ${styles.meta}`}>
          <span>{project.image_count} photos</span>
          <span aria-hidden="true">·</span>
          <time dateTime={project.created_at} title={formatDate(project.created_at)}>
            {relativeTime(project.created_at)}
          </time>
        </p>
      </div>
    </article>
  );
}

export default function Projects() {
  const navigate = useNavigate();
  const toast = useToast();
  const [projects, setProjects] = useState(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [toDelete, setToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    api.projects
      .list({ signal: ctrl.signal })
      .then((list) => {
        setProjects(list);
        setError('');
      })
      .catch((err) => {
        if (err.name !== 'AbortError') setError(err.message);
      });
    return () => ctrl.abort();
  }, [reload]);

  // Keep processing projects fresh without a stream per card.
  const processing = projects?.some((p) => p.status === 'processing');
  useEffect(() => {
    if (!processing) return undefined;
    const t = setInterval(() => setReload((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, [processing]);

  const confirmDelete = async () => {
    const project = toDelete;
    setDeleting(true);
    try {
      await api.projects.remove(project.id);
      setProjects((list) => list.filter((p) => p.id !== project.id));
      toast.success('Project deleted', `“${project.name}” and its files were removed.`);
      setToDelete(null);
    } catch (err) {
      toast.error('Delete failed', err.message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className={`container ${styles.page}`}>
      <header className={styles.head}>
        <div className="stack" style={{ '--gap': '6px' }}>
          <span className="eyebrow">Workspace</span>
          <h1 className={styles.title}>Projects</h1>
        </div>
        <span className="spacer" />
        <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
          <Icon name="plus" /> New project
        </button>
      </header>

      {error && (
        <div className="callout callout--danger" role="alert">
          <Icon name="alert" />
          <div className="stack" style={{ '--gap': '8px' }}>
            <span>Couldn’t load your projects: {error}</span>
            <div>
              <button type="button" className="btn btn--sm" onClick={() => setReload((n) => n + 1)}>
                <Icon name="refresh" /> Retry
              </button>
            </div>
          </div>
        </div>
      )}

      {!projects && !error && (
        <div className={styles.grid} aria-busy="true" aria-label="Loading projects">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={`card ${styles.card}`}>
              <div className={`skeleton ${styles.thumb}`} style={{ borderRadius: 0 }} />
              <div className={styles.body}>
                <div className="skeleton skeleton-text" style={{ width: '55%', height: 18 }} />
                <div className="skeleton skeleton-text" style={{ width: '35%' }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {projects?.length === 0 && (
        <div className="empty">
          <svg viewBox="0 0 160 100" aria-hidden="true">
            <rect x="28" y="22" width="56" height="42" rx="4" fill="none" stroke="currentColor" strokeWidth="2" transform="rotate(-8 56 43)" />
            <rect x="56" y="18" width="56" height="42" rx="4" fill="var(--surface)" stroke="currentColor" strokeWidth="2" transform="rotate(5 84 39)" />
            <path d="M118 52 136 62v20l-18 10-18-10V62z" fill="var(--surface)" stroke="var(--accent)" strokeWidth="2.4" strokeLinejoin="round" />
            <path d="M118 72v20M118 72l18-10M118 72l-18-10" stroke="var(--accent)" strokeWidth="1.6" />
          </svg>
          <h2 style={{ fontSize: '1.4rem' }}>No projects yet</h2>
          <p>A project holds one capture: the photos of a single object or scene, and every model you build from them.</p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
              <Icon name="plus" /> New project
            </button>
            <Link to="/" state={{ scrollTo: 'samples' }} className="btn">
              Start from a sample
            </Link>
          </div>
        </div>
      )}

      {projects?.length > 0 && (
        <div className={styles.grid}>
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} onDelete={setToDelete} />
          ))}
        </div>
      )}

      <NewProjectDialog
        key={creating ? 'open' : 'closed'}
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(p) => navigate(`/projects/${p.id}`)}
      />
      <ConfirmDialog
        open={Boolean(toDelete)}
        title="Delete project?"
        confirmLabel="Delete project"
        danger
        busy={deleting}
        onConfirm={confirmDelete}
        onClose={() => setToDelete(null)}
      >
        “{toDelete?.name}” will be permanently deleted, including its {toDelete?.image_count ?? 0} photos and all generated
        models. This can’t be undone.
      </ConfirmDialog>
    </div>
  );
}
