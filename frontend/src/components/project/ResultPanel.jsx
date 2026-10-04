import { lazy, Suspense } from 'react';
import { api } from '../../api/index.js';
import { formatBytes, formatDateTime, formatDuration, formatNumber, humanize, jobDuration } from '../../lib/format.js';
import Icon from '../ui/Icon.jsx';
import styles from './ResultPanel.module.css';

const ModelViewer = lazy(() => import('../viewer/ModelViewer.jsx'));

const DOWNLOADS = {
  glb: { label: 'GLB', text: 'Web, Blender, Unity, Unreal' },
  obj_zip: { label: 'OBJ (zip)', text: 'Mesh + MTL + textures' },
  ply: { label: 'PLY', text: 'MeshLab, CloudCompare' },
  usdz: { label: 'USDZ', text: 'Apple AR Quick Look' },
  report: { label: 'Report', text: 'Pipeline report (JSON)' },
};
const DOWNLOAD_ORDER = ['glb', 'obj_zip', 'ply', 'usdz', 'report'];

const METRIC_LABELS = {
  registered_images: 'Aligned photos',
  input_images: 'Input photos',
  faces: 'Faces',
  vertices: 'Vertices',
  points: 'Dense points',
  dense_points: 'Dense points',
  sparse_points: 'Sparse points',
  texture_size: 'Texture',
  reprojection_error: 'Reproj. error',
  mean_reprojection_error: 'Reproj. error',
  duration_s: 'Pipeline time',
  elapsed_s: 'Pipeline time',
  device: 'Device',
};

function metricValue(key, value) {
  if (value == null) return '—';
  if (/(_s|_seconds|duration)$/.test(key) && typeof value === 'number') return formatDuration(value);
  if (key === 'texture_size' && typeof value === 'number') return `${value}²`;
  if (/error/.test(key) && typeof value === 'number') return `${value.toFixed(2)} px`;
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 40);
  return String(value);
}

export function Metrics({ job }) {
  const m = job.metrics ?? {};
  const entries = [];
  if (m.registered_images != null && m.input_images != null) {
    entries.push(['Aligned photos', `${formatNumber(m.registered_images)} / ${formatNumber(m.input_images)}`]);
  }
  for (const [k, v] of Object.entries(m)) {
    if (entries.length && (k === 'registered_images' || k === 'input_images')) continue;
    if (Array.isArray(v)) continue;
    entries.push([METRIC_LABELS[k] ?? humanize(k), metricValue(k, v)]);
  }
  const dur = jobDuration(job);
  if (dur != null && !('duration_s' in m) && !('elapsed_s' in m)) entries.push(['Total time', formatDuration(dur)]);
  if (job.options?.quality) entries.push(['Quality', humanize(job.options.quality)]);

  return (
    <dl className={styles.metrics}>
      {entries.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd className="mono tnum">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Downloads({ artifacts }) {
  const list = artifacts
    .filter((a) => DOWNLOADS[a.kind])
    .sort((a, b) => DOWNLOAD_ORDER.indexOf(a.kind) - DOWNLOAD_ORDER.indexOf(b.kind));
  if (!list.length) return <p className="muted small">No downloadable files were produced.</p>;
  return (
    <ul className={styles.downloads}>
      {list.map((a) => (
        <li key={a.id}>
          <a href={api.assetUrl(a.url)} download={a.filename} className={`${styles.dl} ${a.kind === 'glb' ? styles.dlPrimary : ''}`}>
            <span className={styles.dlFmt}>{DOWNLOADS[a.kind].label}</span>
            <span className={styles.dlText}>
              <span>{DOWNLOADS[a.kind].text}</span>
              <span className="mono muted">{formatBytes(a.size_bytes)}</span>
            </span>
            <Icon name="download" className={styles.dlIcon} />
            <span className="visually-hidden">Download {a.filename}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * Result of a succeeded job: 3D viewer (preview first, then full GLB), metrics and downloads.
 */
export default function ResultPanel({ job, projectName, isLatest }) {
  const byKind = Object.fromEntries((job.artifacts ?? []).map((a) => [a.kind, a]));
  const sources = [];
  if (byKind.preview) sources.push({ url: api.assetUrl(byKind.preview.url), label: 'Preview' });
  if (byKind.glb) sources.push({ url: api.assetUrl(byKind.glb.url), label: 'Full model' });

  return (
    <section className={`card panel ${styles.panel}`} aria-labelledby="result-title">
      <div className="panel__head">
        <h2 id="result-title" className="panel__title">
          <span className="step-num">4</span> Your model
        </h2>
        {!isLatest && <span className="badge badge--info badge--plain">Earlier run</span>}
        <span className="spacer" />
        <span className="mono small muted">finished {formatDateTime(job.finished_at)}</span>
      </div>
      <div className={styles.layout}>
        <div className={styles.viewerCol}>
          {sources.length ? (
            <Suspense fallback={<div className={`skeleton ${styles.viewerSkeleton}`} aria-label="Loading 3D viewer" />}>
              <ModelViewer
                key={job.id}
                sources={sources}
                title={`3D model of ${projectName}`}
                filename={byKind.glb?.filename ?? projectName}
                ar={{ usdz: byKind.usdz ? api.assetUrl(byKind.usdz.url) : null, glb: byKind.glb ? api.assetUrl(byKind.glb.url) : null }}
              />
            </Suspense>
          ) : (
            <div className="empty">
              <p>This job finished without a viewable GLB. Check the downloads for other formats.</p>
            </div>
          )}
        </div>
        <div className={styles.side}>
          <div>
            <h3 className={`eyebrow ${styles.sideTitle}`}>Download</h3>
            <Downloads artifacts={job.artifacts ?? []} />
          </div>
          <div>
            <h3 className={`eyebrow ${styles.sideTitle}`}>Metrics</h3>
            <Metrics job={job} />
          </div>
        </div>
      </div>
    </section>
  );
}
