const PROJECT = {
  empty: { tone: '', label: 'No photos' },
  ready: { tone: 'info', label: 'Ready' },
  processing: { tone: 'accent', label: 'Processing', live: true },
  done: { tone: 'ok', label: 'Done' },
  failed: { tone: 'danger', label: 'Failed' },
};

const JOB = {
  queued: { tone: 'warn', label: 'Queued', live: true },
  running: { tone: 'accent', label: 'Running', live: true },
  succeeded: { tone: 'ok', label: 'Succeeded' },
  failed: { tone: 'danger', label: 'Failed' },
  canceled: { tone: '', label: 'Canceled' },
};

export default function StatusBadge({ status, kind = 'project' }) {
  const map = kind === 'job' ? JOB : PROJECT;
  const meta = map[status] ?? { tone: '', label: status ?? 'Unknown' };
  const cls = ['badge', meta.tone && `badge--${meta.tone}`, meta.live && 'badge--live'].filter(Boolean).join(' ');
  return <span className={cls}>{meta.label}</span>;
}
