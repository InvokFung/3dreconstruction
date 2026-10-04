import { compactNumber, formatDateTime, formatDuration, humanize, jobDuration } from '../../lib/format.js';
import Icon from '../ui/Icon.jsx';
import StatusBadge from '../ui/StatusBadge.jsx';
import styles from './JobHistory.module.css';

/**
 * Every run of this project, newest first, with "view" for finished models and "re-run".
 */
export default function JobHistory({ jobs, selectedId, onView, onRerun, rerunDisabled }) {
  if (!jobs) {
    return (
      <div className="stack" style={{ '--gap': '8px' }} aria-busy="true">
        {[0, 1].map((i) => (
          <div key={i} className="skeleton" style={{ height: 52 }} />
        ))}
      </div>
    );
  }
  if (!jobs.length) return <p className="muted small">No runs yet. Your reconstructions will be listed here.</p>;

  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Status</th>
            <th scope="col">Started</th>
            <th scope="col">Settings</th>
            <th scope="col">Duration</th>
            <th scope="col">Faces</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const o = job.options ?? {};
            const selected = job.id === selectedId;
            return (
              <tr key={job.id} className={selected ? styles.selected : undefined} aria-current={selected ? 'true' : undefined}>
                <td data-label="Status">
                  <StatusBadge kind="job" status={job.status} />
                </td>
                <td data-label="Started" className="mono tnum">
                  {formatDateTime(job.created_at)}
                </td>
                <td data-label="Settings">
                  <span className={styles.settings}>
                    {humanize(job.engine)} · {humanize(o.quality ?? 'standard')} · {humanize(o.mode ?? 'object')}
                    {o.texture_size && <span className="muted"> · {o.texture_size}px</span>}
                  </span>
                </td>
                <td data-label="Duration" className="mono tnum">
                  {formatDuration(jobDuration(job))}
                </td>
                <td data-label="Faces" className="mono tnum">
                  {job.metrics?.faces != null ? compactNumber(job.metrics.faces) : '—'}
                </td>
                <td className={styles.actions}>
                  {job.status === 'succeeded' && (
                    <button type="button" className="btn btn--sm" onClick={() => onView(job)} disabled={selected} aria-label={`View model from ${formatDateTime(job.created_at)}`}>
                      <Icon name="cube" /> {selected ? 'Viewing' : 'View'}
                    </button>
                  )}
                  {(job.status === 'failed' || job.status === 'canceled') && (
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => onView(job)} disabled={selected}>
                      Details
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => onRerun(job)}
                    disabled={rerunDisabled}
                    aria-label={`Re-run with settings from ${formatDateTime(job.created_at)}`}
                    title="Run again with these settings"
                  >
                    <Icon name="refresh" /> Re-run
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
