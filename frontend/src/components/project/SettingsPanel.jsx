import { useId, useState } from 'react';
import { formatNumber } from '../../lib/format.js';
import Icon from '../ui/Icon.jsx';
import styles from './SettingsPanel.module.css';

const DEFAULT_OPTIONS = { quality: 'standard', mode: 'object', texture_size: 2048, target_faces: 100000 };

const ENGINE_META = {
  photogrammetry: { title: 'Photogrammetry', text: 'Multi-view stereo. Accurate geometry and true photo colour.' },
  generative: { title: 'Generative', text: 'Learned model. Fills in unseen sides from few photos.' },
};

const QUALITY = [
  { value: 'draft', label: 'Draft', perPhoto: 4, base: 60, text: 'Quick check' },
  { value: 'standard', label: 'Standard', perPhoto: 12, base: 120, text: 'Balanced' },
  { value: 'high', label: 'High', perPhoto: 35, base: 300, text: 'Max detail' },
];

const FACES = [25000, 50000, 100000, 250000, 500000];
const TEXTURES = [1024, 2048, 4096];

/** Rough wall-clock estimate on a mid-range machine; shown as a range, never as a promise. */
function estimate(q, n) {
  const secs = q.base + q.perPhoto * Math.max(n, 10);
  const lo = Math.max(1, Math.round((secs * 0.6) / 60));
  const hi = Math.max(lo + 1, Math.round((secs * 1.6) / 60));
  return `${lo}–${hi} min`;
}

function Seg({ name, value, options, onChange, legend, disabled }) {
  return (
    <fieldset className={styles.fieldset} disabled={disabled}>
      <legend className="label">{legend}</legend>
      <div className="seg" style={{ width: '100%' }}>
        {options.map((o) => (
          <label key={o.value} className="seg__opt">
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Reconstruction settings form.
 * @param {{engines:object|null, enginesError?:string, imageCount:number, blocked?:string|null, busy?:boolean,
 *   initial?:{engine?:string, options?:object}, onStart:(req:{engine:string, options:object})=>void}} props
 */
export default function SettingsPanel({ engines, enginesError, imageCount, blocked, busy, initial, onStart }) {
  const id = useId();
  const engineList = engines?.engines ? Object.entries(engines.engines) : [];
  const firstAvailable = engineList.find(([, e]) => e.available)?.[0];
  const [engineChoice, setEngine] = useState(initial?.engine ?? null);
  const [opts, setOpts] = useState({ ...DEFAULT_OPTIONS, ...(initial?.options ?? {}) });
  const set = (k) => (v) => setOpts((o) => ({ ...o, [k]: v }));

  const engine = engineChoice && engines?.engines?.[engineChoice]?.available ? engineChoice : firstAvailable ?? engineChoice ?? 'photogrammetry';
  const engineOk = !engines || engines.engines?.[engine]?.available !== false;

  let reason = blocked;
  if (!reason && imageCount === 0) reason = 'Upload photos first.';
  if (!reason && engines && !firstAvailable) reason = 'No reconstruction engine is available on the server.';

  const submit = (e) => {
    e.preventDefault();
    if (reason || !engineOk) return;
    onStart({
      engine,
      options: { ...opts, texture_size: Number(opts.texture_size), target_faces: Number(opts.target_faces) },
    });
  };

  return (
    <form className={styles.form} onSubmit={submit} aria-describedby={reason ? `${id}-reason` : undefined}>
      <fieldset className={styles.fieldset}>
        <legend className="label">
          Engine
          {engines?.device && <span className={`badge badge--plain ${styles.device}`}>{engines.device}</span>}
        </legend>
        {!engines && !enginesError && (
          <div className={styles.engines}>
            <div className="skeleton" style={{ height: 76 }} />
            <div className="skeleton" style={{ height: 76 }} />
          </div>
        )}
        {enginesError && (
          <p className="hint">
            Couldn’t load engine status ({enginesError}). Photogrammetry will be used.
          </p>
        )}
        {engineList.length > 0 && (
          <div className={styles.engines}>
            {engineList.map(([name, info]) => {
              const meta = ENGINE_META[name] ?? { title: name[0].toUpperCase() + name.slice(1), text: '' };
              return (
                <label key={name} className="choice">
                  <input
                    type="radio"
                    name={`${id}-engine`}
                    value={name}
                    checked={engine === name}
                    disabled={!info.available}
                    onChange={() => setEngine(name)}
                    aria-describedby={`${id}-${name}-desc`}
                  />
                  <span className="choice__body">
                    <span className="choice__title">
                      {meta.title}
                      {!info.available && <span className="badge badge--plain">Unavailable</span>}
                    </span>
                    <span id={`${id}-${name}-desc`} className="choice__meta">
                      {info.available ? info.notes || meta.text : info.reason || 'Not available on this server.'}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </fieldset>

      <fieldset className={styles.fieldset}>
        <legend className="label">Quality</legend>
        <div className={styles.quality}>
          {QUALITY.map((q) => (
            <label key={q.value} className="choice">
              <input type="radio" name={`${id}-quality`} value={q.value} checked={opts.quality === q.value} onChange={() => set('quality')(q.value)} />
              <span className="choice__body">
                <span className="choice__title">{q.label}</span>
                <span className="choice__meta">{q.text}</span>
                <span className={`mono ${styles.time}`}>
                  <Icon name="clock" /> {estimate(q, imageCount)}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <Seg
        name={`${id}-mode`}
        legend="Mode"
        value={opts.mode}
        onChange={set('mode')}
        options={[
          { value: 'object', label: 'Object' },
          { value: 'scene', label: 'Scene' },
        ]}
      />
      <p className={`hint ${styles.modeHint}`}>
        {opts.mode === 'object' ? 'Isolates the subject and removes the background.' : 'Keeps everything in view: rooms, facades, terrain.'}
      </p>

      <div className={styles.twoCol}>
        <div className="field">
          <label className="label" htmlFor={`${id}-tex`}>
            Texture size
          </label>
          <select id={`${id}-tex`} className="select" value={opts.texture_size} onChange={(e) => set('texture_size')(Number(e.target.value))}>
            {TEXTURES.map((t) => (
              <option key={t} value={t}>
                {t} × {t}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="label" htmlFor={`${id}-faces`}>
            Target faces
          </label>
          <select id={`${id}-faces`} className="select" value={opts.target_faces} onChange={(e) => set('target_faces')(Number(e.target.value))}>
            {FACES.map((f) => (
              <option key={f} value={f}>
                {formatNumber(f)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="hint">Lower face counts load faster on the web and in AR; higher keeps fine detail.</p>

      <div className={styles.footer}>
        <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={Boolean(reason) || !engineOk || busy}>
          {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="cube" />}
          Start reconstruction
        </button>
        {reason && (
          <p id={`${id}-reason`} className="hint" style={{ textAlign: 'center' }}>
            {reason}
          </p>
        )}
      </div>
    </form>
  );
}
