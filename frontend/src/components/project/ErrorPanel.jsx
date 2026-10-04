import { errorHints } from '../../lib/errorHints.js';
import { stageLabel } from '../../lib/stages.js';
import { formatDateTime } from '../../lib/format.js';
import Icon from '../ui/Icon.jsx';
import { LogView, StageStepper } from './ProgressPanel.jsx';
import styles from './ErrorPanel.module.css';

/**
 * Failed (or canceled) job: the server's message, where it stopped, and what to do next.
 */
export default function ErrorPanel({ job, logs = [], onRetry, onGoTo, retrying, onDismiss }) {
  const canceled = job.status === 'canceled';
  const { hints, actions } = errorHints(job);

  return (
    <section className={`card panel ${styles.panel} ${canceled ? styles.canceled : ''}`} aria-labelledby="error-title" role={canceled ? undefined : 'alert'}>
      <div className={styles.head}>
        <Icon name={canceled ? 'stop' : 'alert'} className={styles.icon} />
        <div className="stack" style={{ '--gap': '4px', flex: 1, minWidth: 0 }}>
          <h2 id="error-title" className={styles.title}>
            {canceled ? 'Reconstruction canceled' : 'Reconstruction failed'}
            {job.stage && !canceled && <span className={styles.at}> at {stageLabel(job.stage)}</span>}
          </h2>
          <p className={styles.message}>
            {canceled ? 'The job was stopped before it finished. Your photos are untouched.' : job.error || job.message || 'The pipeline stopped without an error message.'}
          </p>
          <p className="mono small muted">{formatDateTime(job.finished_at || job.created_at)}</p>
        </div>
        {onDismiss && (
          <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={onDismiss} aria-label="Dismiss">
            <Icon name="x" />
          </button>
        )}
      </div>

      {!canceled && (
        <>
          <StageStepper job={job} />
          <div className={styles.hints}>
            <h3 className="eyebrow">What to try</h3>
            <ul>
              {hints.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          </div>
        </>
      )}

      <div className="row">
        {actions.includes('retry') && (
          <button type="button" className="btn btn--primary" onClick={onRetry} disabled={retrying}>
            {retrying ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" />}
            Retry with same settings
          </button>
        )}
        {actions.includes('photos') && (
          <button type="button" className="btn" onClick={() => onGoTo('photos')}>
            <Icon name="camera" /> Add photos
          </button>
        )}
        {(actions.includes('settings') || canceled) && (
          <button type="button" className="btn" onClick={() => onGoTo('settings')}>
            Adjust settings
          </button>
        )}
      </div>

      {logs.length > 0 && (
        <details className="disclosure">
          <summary>Log ({logs.length} lines)</summary>
          <LogView logs={logs} />
        </details>
      )}
    </section>
  );
}
