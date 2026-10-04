import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../../api/index.js';
import { formatBytes } from '../../lib/format.js';
import { useToast } from '../../hooks/toast.jsx';
import Icon from '../ui/Icon.jsx';
import styles from './UploadPanel.module.css';

const CONCURRENCY = 3;
const COLLAPSED = 16;
const MAX_MB = 50;
const MAX_FILES = 200;
const EXT = /\.(jpe?g|png|webp|heic|heif|tiff?|mp4|mov|m4v|webm)$/i;
const ACCEPT = 'image/*,video/*,.heic,.heif';

const TIPS = [
  { icon: 'layers', title: 'Overlap 60–80%', text: 'Each photo should share most of its view with the previous one.' },
  { icon: 'rotate', title: 'Walk around it', text: 'Circle the object at two or three heights. Move, don’t just turn.' },
  { icon: 'sun', title: 'Even, soft light', text: 'Overcast daylight or diffuse lamps. Avoid hard shadows and flash.' },
  { icon: 'eyeOff', title: 'Skip shiny & clear', text: 'Reflective or transparent surfaces confuse matching. Matte them or pick another subject.' },
  { icon: 'camera', title: '20–80 sharp photos', text: 'Fixed zoom, subject filling most of the frame, no motion blur.' },
];

let seq = 0;
const isAccepted = (f) => f.type.startsWith('image/') || f.type.startsWith('video/') || EXT.test(f.name);
const isVideo = (f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(f.name);

function CountMeter({ count }) {
  const pct = Math.min(100, (count / 100) * 100);
  let tone = 'warn';
  let text = `Add at least ${Math.max(0, 20 - count)} more for a reliable reconstruction.`;
  if (count === 0) text = 'No photos yet. 20–80 is the sweet spot.';
  else if (count >= 20 && count <= 80) {
    tone = 'ok';
    text = 'Good coverage.';
  } else if (count > 80) {
    tone = 'info';
    text = 'Plenty of photos. High quality will take a while.';
  }
  return (
    <div className={styles.meter}>
      <div className={styles.meterTrack} aria-hidden="true">
        <span className={styles.meterBand} />
        <span className={`${styles.meterFill} ${styles[tone]}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="small">
        <strong className="mono">{count}</strong> <span className="muted">{count === 1 ? 'file' : 'files'} · {text}</span>
      </p>
    </div>
  );
}

/**
 * Photo/video upload with drag-and-drop, per-file XHR progress, thumbnails and capture tips.
 */
export default function UploadPanel({ projectId, images, locked, onAdded, onRemoved }) {
  const inputId = useId();
  const toast = useToast();
  const inputRef = useRef(null);
  const [items, setItems] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [removing, setRemoving] = useState(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const queue = useRef([]);
  const active = useRef(0);
  const controllers = useRef(new Map());
  const previews = useRef(new Set());
  const dragDepth = useRef(0);

  // Abort in-flight uploads and free object URLs when leaving the page.
  useEffect(() => {
    const ctrls = controllers.current;
    const urls = previews.current;
    return () => {
      ctrls.forEach((c) => c.abort());
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  const patch = (key, changes) => setItems((list) => list.map((i) => (i.key === key ? { ...i, ...changes } : i)));
  const drop = (key) =>
    setItems((list) => {
      const item = list.find((i) => i.key === key);
      if (item?.preview) {
        URL.revokeObjectURL(item.preview);
        previews.current.delete(item.preview);
      }
      return list.filter((i) => i.key !== key);
    });

  function pump() {
    while (active.current < CONCURRENCY && queue.current.length) {
      const item = queue.current.shift();
      active.current += 1;
      const ctrl = new AbortController();
      controllers.current.set(item.key, ctrl);
      patch(item.key, { status: 'uploading', progress: 0, error: null });
      api.projects
        .uploadImage(projectId, item.file, { signal: ctrl.signal, onProgress: (p) => patch(item.key, { progress: p }) })
        .then((created) => {
          onAdded(created);
          drop(item.key);
        })
        .catch((err) => {
          if (err?.name === 'AbortError') drop(item.key);
          else patch(item.key, { status: 'error', error: err.message });
        })
        .finally(() => {
          controllers.current.delete(item.key);
          active.current -= 1;
          pump();
        });
    }
  }

  const addFiles = (fileList) => {
    if (locked) return;
    const files = Array.from(fileList ?? []);
    if (!files.length) return;
    const room = MAX_FILES - images.length - items.filter((i) => i.status !== 'error').length;
    const next = files.map((file, idx) => {
      seq += 1;
      const key = `u${seq}`;
      let error = null;
      if (!isAccepted(file)) error = 'Not an image or video';
      else if (file.size > MAX_MB * 1024 * 1024) error = `Larger than ${MAX_MB} MB`;
      else if (idx >= room) error = `Project limit of ${MAX_FILES} files reached`;
      let preview = null;
      if (!error && file.type.startsWith('image/') && !/hei[cf]/i.test(file.type)) {
        preview = URL.createObjectURL(file);
        previews.current.add(preview);
      }
      return { key, file, name: file.name, size: file.size, video: isVideo(file), preview, progress: 0, status: error ? 'error' : 'queued', error, rejected: Boolean(error) };
    });
    setItems((list) => [...list, ...next]);
    queue.current.push(...next.filter((i) => i.status === 'queued'));
    pump();
  };

  const retry = (item) => {
    patch(item.key, { status: 'queued', error: null, progress: 0 });
    queue.current.push(item);
    pump();
  };

  const cancel = (item) => {
    const ctrl = controllers.current.get(item.key);
    if (ctrl) ctrl.abort();
    else {
      queue.current = queue.current.filter((q) => q.key !== item.key);
      drop(item.key);
    }
  };

  const remove = async (image) => {
    setRemoving((s) => new Set(s).add(image.id));
    try {
      await api.projects.removeImage(projectId, image.id);
      onRemoved(image.id);
    } catch (err) {
      toast.error(`Couldn’t remove ${image.filename}`, err.message);
    } finally {
      setRemoving((s) => {
        const n = new Set(s);
        n.delete(image.id);
        return n;
      });
    }
  };

  const onDragEnter = (e) => {
    if (locked || !e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragging(false);
  };
  const onDragOver = (e) => {
    if (locked) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (e) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    addFiles(e.dataTransfer?.files);
  };

  const uploading = items.filter((i) => i.status === 'uploading' || i.status === 'queued');
  const totalBytes = uploading.reduce((a, i) => a + i.size, 0);
  const doneBytes = uploading.reduce((a, i) => a + i.size * (i.progress || 0), 0);

  return (
    <div className={styles.layout}>
      <div className={styles.main} onDragEnter={onDragEnter} onDragLeave={onDragLeave} onDragOver={onDragOver} onDrop={onDrop}>
        <div className={`${styles.drop} ${dragging ? styles.dragging : ''} ${locked ? styles.locked : ''}`}>
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            multiple
            accept={ACCEPT}
            className="visually-hidden"
            tabIndex={-1}
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = '';
            }}
            disabled={locked}
          />
          <Icon name="upload" className={styles.dropIcon} />
          {locked ? (
            <p>Photos are locked while a reconstruction is running.</p>
          ) : (
            <>
              <p>
                <strong>Drop photos or a video here</strong>
                <span className="muted"> or</span>
              </p>
              <button type="button" className="btn btn--ink btn--sm" onClick={() => inputRef.current?.click()}>
                Choose files
              </button>
              <p className="hint">JPG, PNG, WebP, HEIC, MP4, MOV, WebM · up to {MAX_MB} MB each</p>
            </>
          )}
        </div>

        {uploading.length > 0 && (
          <div className={styles.summary} role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <span>
              Uploading {uploading.length} {uploading.length === 1 ? 'file' : 'files'} · {formatBytes(doneBytes)} of {formatBytes(totalBytes)}
            </span>
          </div>
        )}

        <CountMeter count={images.length} />

        {(images.length > 0 || items.length > 0) && (
          <ul className={styles.grid} aria-label="Project photos">
            {items.map((item) => (
              <li key={item.key} className={`${styles.tile} ${item.status === 'error' ? styles.tileError : ''}`}>
                {item.preview ? <img src={item.preview} alt="" /> : <div className={styles.tileIcon}><Icon name={item.video ? 'video' : 'image'} /></div>}
                <div className={styles.tileOverlay}>
                  {item.status === 'error' ? (
                    <>
                      <Icon name="alert" className={styles.errIcon} />
                      <span className={styles.tileMsg} title={item.error}>{item.error}</span>
                      <div className={styles.tileActions}>
                        {!item.rejected && (
                          <button type="button" className={styles.miniBtn} onClick={() => retry(item)} aria-label={`Retry uploading ${item.name}`}>
                            <Icon name="refresh" />
                          </button>
                        )}
                        <button type="button" className={styles.miniBtn} onClick={() => drop(item.key)} aria-label={`Dismiss ${item.name}`}>
                          <Icon name="x" />
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <span className={`mono ${styles.pct}`}>{item.status === 'queued' ? 'queued' : `${Math.round(item.progress * 100)}%`}</span>
                      <div className={styles.tileBar} role="progressbar" aria-label={`Uploading ${item.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.progress * 100)}>
                        <span style={{ width: `${item.progress * 100}%` }} />
                      </div>
                      <button type="button" className={`${styles.miniBtn} ${styles.cornerBtn}`} onClick={() => cancel(item)} aria-label={`Cancel upload of ${item.name}`}>
                        <Icon name="x" />
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
            {(showAll ? images : images.slice(0, COLLAPSED)).map((img) => (
              <li key={img.id} className={`${styles.tile} ${removing.has(img.id) ? styles.removing : ''}`}>
                <img src={api.assetUrl(img.thumb_url)} alt={img.filename} loading="lazy" />
                {img.kind === 'video' && (
                  <span className={styles.videoTag}>
                    <Icon name="video" /> video
                  </span>
                )}
                {!locked && (
                  <button
                    type="button"
                    className={`${styles.miniBtn} ${styles.removeBtn}`}
                    onClick={() => remove(img)}
                    disabled={removing.has(img.id)}
                    aria-label={`Remove ${img.filename}`}
                    title="Remove"
                  >
                    <Icon name="x" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {images.length > COLLAPSED && (
          <button type="button" className="btn btn--ghost btn--sm" style={{ alignSelf: 'center' }} onClick={() => setShowAll((s) => !s)} aria-expanded={showAll}>
            {showAll ? 'Show fewer' : `Show all ${images.length} files`}
          </button>
        )}
      </div>

      <aside className={styles.tips} aria-labelledby={`${inputId}-tips`}>
        <h3 id={`${inputId}-tips`} className="eyebrow">
          Capture tips
        </h3>
        <ul>
          {TIPS.map((t) => (
            <li key={t.title}>
              <Icon name={t.icon} />
              <div>
                <strong>{t.title}</strong>
                <p className="muted small">{t.text}</p>
              </div>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
