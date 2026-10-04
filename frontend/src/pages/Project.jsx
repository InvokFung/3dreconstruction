import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/index.js';
import { isTerminal } from '../lib/jobReducer.js';
import { formatDate } from '../lib/format.js';
import { useJobStream } from '../hooks/useJobStream.js';
import { useToast } from '../hooks/toast.jsx';
import { ConfirmDialog } from '../components/ui/Dialog.jsx';
import Icon from '../components/ui/Icon.jsx';
import StatusBadge from '../components/ui/StatusBadge.jsx';
import UploadPanel from '../components/project/UploadPanel.jsx';
import SettingsPanel from '../components/project/SettingsPanel.jsx';
import ProgressPanel from '../components/project/ProgressPanel.jsx';
import ResultPanel from '../components/project/ResultPanel.jsx';
import ErrorPanel from '../components/project/ErrorPanel.jsx';
import JobHistory from '../components/project/JobHistory.jsx';
import styles from './Project.module.css';

function ProjectSkeleton() {
  return (
    <div className={`container ${styles.page}`} aria-busy="true" aria-label="Loading project">
      <div className="skeleton" style={{ width: 90, height: 14 }} />
      <div className="skeleton" style={{ width: 'min(380px, 80%)', height: 40 }} />
      <div className={styles.grid}>
        <div className="skeleton" style={{ height: 420, borderRadius: 14 }} />
        <div className="skeleton" style={{ height: 420, borderRadius: 14 }} />
      </div>
    </div>
  );
}

function EditableTitle({ project, onSave }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(project.name);
  const [busy, setBusy] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    const name = value.trim();
    if (!name || name === project.name) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await onSave({ name });
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <form className={styles.titleForm} onSubmit={save}>
        <label htmlFor="project-name" className="visually-hidden">
          Project name
        </label>
        <input
          id="project-name"
          className={`input ${styles.titleInput}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
          maxLength={120}
          autoFocus
        />
        <button type="submit" className="btn btn--primary btn--sm" disabled={busy}>
          Save
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </form>
    );
  }
  return (
    <div className={styles.titleRow}>
      <h1 className={styles.title}>{project.name}</h1>
      <button
        type="button"
        className="btn btn--ghost btn--icon btn--sm"
        onClick={() => {
          setValue(project.name);
          setEditing(true);
        }}
        aria-label="Rename project"
        title="Rename"
      >
        <Icon name="edit" />
      </button>
    </div>
  );
}

export default function Project() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [project, setProject] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [jobList, setJobs] = useState(null);
  const [engines, setEngines] = useState(null);
  const [enginesError, setEnginesError] = useState('');
  const [details, setDetails] = useState({});
  const [viewJobId, setViewJobId] = useState(null);
  const [dismissed, setDismissed] = useState(null);
  const [starting, setStarting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const initialised = useRef(null);
  const topRef = useRef(null);
  const photosRef = useRef(null);
  const settingsRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const [p, j] = await Promise.all([api.projects.get(projectId), api.projects.jobs(projectId)]);
      setProject(p);
      setJobs(j);
    } catch {
      /* the next interaction will surface errors */
    }
  }, [projectId]);

  const onJobEnd = useCallback(
    (job) => {
      if (job.status === 'succeeded') toast.success('Model ready', 'Your reconstruction finished. Take a look!');
      else if (job.status === 'failed') toast.error('Reconstruction failed', job.error || undefined);
      setJobs((list) => list?.map((j) => (j.id === job.id ? { ...j, ...job } : j)) ?? list);
      if (job.artifacts?.length) setDetails((d) => ({ ...d, [job.id]: job }));
      setViewJobId(null);
      refresh();
    },
    [toast, refresh],
  );

  const [stream, dispatch] = useJobStream(onJobEnd);
  const current = stream.job;
  const active = Boolean(current) && !isTerminal(current);

  // Initial load (and retry).
  useEffect(() => {
    const ctrl = new AbortController();
    const { signal } = ctrl;
    Promise.all([api.projects.get(projectId, { signal }), api.projects.jobs(projectId, { signal })])
      .then(([p, j]) => {
        setProject(p);
        setJobs(j);
        setLoadError(null);
        // Restore the latest job (and its live stream if it is still running) once per project.
        if (initialised.current !== projectId) {
          initialised.current = projectId;
          const latest = p.latest_job ?? j[0] ?? null;
          dispatch({ type: 'reset', job: latest });
        }
      })
      .catch((err) => {
        if (err.name !== 'AbortError') setLoadError(err);
      });
    api
      .engines({ signal })
      .then(setEngines)
      .catch((err) => {
        if (err.name !== 'AbortError') setEnginesError(err.message);
      });
    return () => ctrl.abort();
  }, [projectId, reloadKey, dispatch]);

  // History merged with the live job, so badges and progress stay in sync without refetching.
  const jobs = useMemo(() => {
    if (!jobList || !current) return jobList;
    const idx = jobList.findIndex((j) => j.id === current.id);
    if (idx === -1) return [current, ...jobList];
    const next = jobList.slice();
    next[idx] = { ...jobList[idx], ...current };
    return next;
  }, [jobList, current]);

  const jobsById = useMemo(() => Object.fromEntries((jobs ?? []).map((j) => [j.id, details[j.id] ?? j])), [jobs, details]);
  const latestSucceeded = jobs?.find((j) => j.status === 'succeeded');
  // What to show: a job pinned from the history, else the latest failure (until dismissed) and the latest model.
  const pinned = viewJobId ? jobsById[viewJobId] : null;
  let failedJob = null;
  let shownResult = null;
  if (pinned) {
    if (pinned.status === 'succeeded') shownResult = pinned;
    else if (isTerminal(pinned)) failedJob = pinned;
  } else {
    if (current && (current.status === 'failed' || current.status === 'canceled') && dismissed !== current.id) failedJob = current;
    const succ = current?.status === 'succeeded' ? current : latestSucceeded;
    if (succ) shownResult = details[succ.id] ?? jobsById[succ.id] ?? succ;
  }

  // Job lists may omit artifacts: fetch the full job when we need to show it.
  const needId = shownResult && !shownResult.artifacts?.length && !details[shownResult.id] ? shownResult.id : null;
  useEffect(() => {
    if (!needId) return;
    api.jobs
      .get(needId)
      .then((job) => setDetails((d) => ({ ...d, [job.id]: job })))
      .catch(() => {});
  }, [needId]);

  const start = useCallback(
    async (req) => {
      setStarting(true);
      try {
        const job = await api.projects.startJob(projectId, req);
        dispatch({ type: 'reset', job });
        setViewJobId(null);
        setDismissed(null);
        setProject((p) => ({ ...p, status: 'processing', latest_job: job }));
        topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (err) {
        toast.error('Couldn’t start the reconstruction', err.message);
      } finally {
        setStarting(false);
      }
    },
    [projectId, dispatch, toast],
  );

  const cancel = useCallback(async () => {
    try {
      const job = await api.jobs.cancel(current.id);
      dispatch({ type: 'job', job });
      toast.info('Canceling', 'The job is being stopped.');
    } catch (err) {
      toast.error('Couldn’t cancel the job', err.message);
      throw err;
    }
  }, [current, dispatch, toast]);

  const onAdded = useCallback((created) => {
    setProject((p) => {
      const images = [...(p.images ?? []), ...created];
      return { ...p, images, image_count: images.length, status: p.status === 'empty' ? 'ready' : p.status };
    });
  }, []);
  const onRemoved = useCallback((imageId) => {
    setProject((p) => {
      const images = (p.images ?? []).filter((i) => i.id !== imageId);
      return { ...p, images, image_count: images.length, status: images.length ? p.status : 'empty' };
    });
  }, []);

  const rename = async (changes) => {
    try {
      const p = await api.projects.update(projectId, changes);
      setProject((cur) => ({ ...cur, ...p, images: p.images ?? cur.images }));
    } catch (err) {
      toast.error('Rename failed', err.message);
      throw err;
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await api.projects.remove(projectId);
      toast.success('Project deleted');
      navigate('/projects', { replace: true });
    } catch (err) {
      toast.error('Delete failed', err.message);
      setDeleting(false);
    }
  };

  const goTo = (where) => {
    const el = where === 'photos' ? photosRef.current : settingsRef.current;
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el?.querySelector('button, input, select')?.focus({ preventScroll: true });
  };

  if (loadError) {
    const missing = loadError.status === 404;
    return (
      <div className={`container ${styles.page}`}>
        <div className="empty">
          <Icon name={missing ? 'folder' : 'alert'} />
          <h1 style={{ fontSize: '1.6rem' }}>{missing ? 'Project not found' : 'Couldn’t load this project'}</h1>
          <p>{missing ? 'It may have been deleted, or the link is wrong.' : loadError.message}</p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <Link to="/projects" className="btn">
              <Icon name="arrowLeft" /> All projects
            </Link>
            {!missing && (
              <button type="button" className="btn btn--primary" onClick={() => setReloadKey((k) => k + 1)}>
                <Icon name="refresh" /> Retry
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
  if (!project) return <ProjectSkeleton />;

  const images = project.images ?? [];
  const status = active ? 'processing' : project.status;
  const lastOptions = current ? { engine: current.engine, options: current.options } : undefined;

  return (
    <div className={`container ${styles.page}`} ref={topRef}>
      <nav aria-label="Breadcrumb" className={styles.crumbs}>
        <Link to="/projects">Projects</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{project.name}</span>
      </nav>

      <header className={styles.head}>
        <div className={styles.headMain}>
          <EditableTitle key={project.name} project={project} onSave={rename} />
          <div className={`row ${styles.meta}`}>
            <StatusBadge status={status} />
            <span className="mono small muted">
              {project.image_count ?? images.length} files · created {formatDate(project.created_at)}
            </span>
          </div>
          {project.description && <p className="muted">{project.description}</p>}
        </div>
        <button type="button" className="btn btn--danger btn--sm" onClick={() => setConfirmDelete(true)}>
          <Icon name="trash" /> Delete
        </button>
      </header>

      {active && <ProgressPanel state={stream} onCancel={cancel} />}

      {failedJob && (
        <ErrorPanel
          job={failedJob}
          logs={failedJob.id === current?.id ? stream.logs : []}
          retrying={starting}
          onRetry={() => start({ engine: failedJob.engine, options: failedJob.options })}
          onGoTo={goTo}
          onDismiss={() => {
            if (viewJobId) setViewJobId(null);
            else setDismissed(failedJob.id);
          }}
        />
      )}

      {shownResult && <ResultPanel job={details[shownResult.id] ?? shownResult} projectName={project.name} isLatest={shownResult.id === jobs?.[0]?.id} />}

      <div className={styles.grid}>
        <section ref={photosRef} className={`card panel ${styles.scrollTarget}`} aria-labelledby="photos-title">
          <div className="panel__head">
            <h2 id="photos-title" className="panel__title">
              <span className="step-num">1</span> Photos
            </h2>
          </div>
          <UploadPanel projectId={projectId} images={images} locked={active} onAdded={onAdded} onRemoved={onRemoved} />
        </section>

        <section ref={settingsRef} className={`card panel ${styles.settings} ${styles.scrollTarget}`} aria-labelledby="settings-title">
          <div className="panel__head">
            <h2 id="settings-title" className="panel__title">
              <span className="step-num">2</span> Reconstruct
            </h2>
          </div>
          <SettingsPanel
            key={current?.id ?? 'new'}
            engines={engines}
            enginesError={enginesError}
            imageCount={images.length}
            blocked={active ? 'A reconstruction is already running.' : null}
            busy={starting}
            initial={lastOptions}
            onStart={start}
          />
        </section>
      </div>

      <section className="card panel" aria-labelledby="history-title">
        <div className="panel__head">
          <h2 id="history-title" className="panel__title">
            <Icon name="clock" width={20} height={20} /> Run history
          </h2>
        </div>
        <JobHistory
          jobs={jobs}
          selectedId={shownResult?.id ?? (viewJobId ? failedJob?.id : null)}
          onView={(job) => {
            setViewJobId(job.id);
            topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
          onRerun={(job) => start({ engine: job.engine, options: job.options })}
          rerunDisabled={active || starting || images.length === 0}
        />
      </section>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete project?"
        confirmLabel="Delete project"
        danger
        busy={deleting}
        onConfirm={remove}
        onClose={() => setConfirmDelete(false)}
      >
        “{project.name}” will be permanently deleted with all {images.length} photos and every generated model.
      </ConfirmDialog>
    </div>
  );
}
