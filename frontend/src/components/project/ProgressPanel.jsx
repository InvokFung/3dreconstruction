import { useEffect, useRef, useState } from 'react';
import { formatDuration, jobDuration } from '../../lib/format.js';
import { stageLabel, stageStates } from '../../lib/stages.js';
import { ConfirmDialog } from '../ui/Dialog.jsx';
import Icon from '../ui/Icon.jsx';
import StatusBadge from '../ui/StatusBadge.jsx';
import styles from './ProgressPanel.module.css';

function useNow(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function StageStepper({ job }) {
  const steps = stageStates(job);
  return (
    <ol className={styles.stepper} aria-label="Pipeline stages">
      {steps.map((s, i) => (
        <li key={s.stage} className={styles[s.state]} aria-current={s.state === 'active' ? 'step' : undefined} title={s.hint}>
          <span className={styles.dot} aria-hidden="true">
            {s.state === 'done' ? <Icon name="check" /> : s.state === 'failed' ? <Icon name="x" /> : i + 1}
          </span>
          <span className={styles.stepLabel}>{s.label}</span>
          <span className="visually-hidden">
            {' '}
            ({s.state === 'active' ? 'in progress' : s.state})
          </span>
        </li>
      ))}
    </ol>
  );
}

const TS = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export function LogView({ logs, live }) {
  const ref = useRef(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [logs.length]);
  return (
    <div
      ref={ref}
      className={styles.log}
      role="log"
      aria-live={live ? 'polite' : 'off'}
      aria-label="Pipeline log"
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {logs.length === 0 && <p className={styles.logEmpty}>Waiting for log output…</p>}
      {logs.map((l, i) => (
        <div key={i} className={`${styles.logLine} ${styles[`lvl_${l.level}`] ?? ''}`}>
          <span className={styles.logTs}>{l.ts ? TS.format(new Date(l.ts)) : ''}</span>
          <span className={styles.logLvl}>{(l.level || 'info').slice(0, 4)}</span>
          <span className={styles.logMsg}>{l.message}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Live progress of a queued/running job.
 * @param {{state:{job:object,logs:object[],connection:string}, onCancel:()=>Promise<void>}} props
 */
export default function ProgressPanel({ state, onCancel }) {
  const { job, logs, connection } = state;
  const now = useNow(true);
  const [confirm, setConfirm] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const pct = Math.max(0, Math.min(100, job.progress ?? 0));
  const elapsed = jobDuration(job, now);
  // naive ETA from linear progress, only once there is enough signal
  const eta = elapsed && pct > 8 && pct < 100 ? (elapsed / pct) * (100 - pct) : null;

  const doCancel = async () => {
    setCanceling(true);
    try {
      await onCancel();
      setConfirm(false);
    } finally {
      setCanceling(false);
    }
  };

  return (
    <section className={`card panel ${styles.panel}`} aria-labelledby="progress-title">
      <div className="panel__head">
        <h2 id="progress-title" className="panel__title">
          <span className="step-num">3</span> Reconstructing
        </h2>
        <StatusBadge kind="job" status={job.status} />
        <span className="spacer" />
        <span className={`${styles.conn} ${styles[`conn_${connection}`] ?? ''}`} role="status">
          <span className={styles.connDot} aria-hidden="true" />
          {connection === 'open' ? 'Live' : connection === 'reconnecting' ? 'Reconnecting…' : connection === 'connecting' ? 'Connecting…' : 'Offline'}
        </span>
        <button type="button" className="btn btn--danger btn--sm" onClick={() => setConfirm(true)} disabled={job.status !== 'queued' && job.status !== 'running'}>
          <Icon name="stop" /> Cancel
        </button>
      </div>

      <StageStepper job={job} />

      <div className={styles.progressBlock}>
        <div className={styles.progressHead}>
          <span className={styles.stageNow}>{job.status === 'queued' ? 'Waiting for a worker' : stageLabel(job.stage) || 'Starting'}</span>
          <span className={`mono tnum ${styles.pct}`}>{pct.toFixed(0)}%</span>
        </div>
        <div
          className="progress progress--live"
          role="progressbar"
          aria-label="Overall progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
        >
          <div className="progress__bar" style={{ width: `${Math.max(pct, 1.5)}%` }} />
        </div>
        <div className={styles.progressMeta}>
          <span className={styles.message} aria-live="polite">
            {job.message || (job.status === 'queued' ? 'Your job is in the queue and will start shortly.' : '…')}
          </span>
          <span className="mono tnum muted">
            {elapsed != null && `elapsed ${formatDuration(elapsed)}`}
            {eta != null && ` · ~${formatDuration(eta)} left`}
          </span>
        </div>
      </div>

      <details className={`disclosure ${styles.logBox}`}>
        <summary>
          <Icon name="terminal" /> Live log <span className="badge badge--plain">{logs.length}</span>
        </summary>
        <LogView logs={logs} live />
      </details>

      <ConfirmDialog
        open={confirm}
        title="Cancel reconstruction?"
        confirmLabel="Cancel job"
        danger
        busy={canceling}
        onConfirm={doCancel}
        onClose={() => setConfirm(false)}
      >
        The pipeline will stop and partial results will be discarded. Your photos stay in the project.
      </ConfirmDialog>
    </section>
  );
}
