import { useCallback, useEffect, useRef, useState } from 'react';
import { compactNumber, formatNumber } from '../../lib/format.js';
import Icon from '../ui/Icon.jsx';
import { BACKGROUNDS, ViewerCore } from './viewerCore.js';
import ArButton from './ArButton.jsx';
import styles from './ModelViewer.module.css';

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

const BG_LABEL = { studio: 'Studio', environment: 'Room', dark: 'Dark', light: 'Light' };

function ToolButton({ icon, label, pressed, onClick, disabled, shortcut, iconOnly }) {
  return (
    <button
      type="button"
      className={styles.tool}
      aria-pressed={pressed === undefined ? undefined : pressed}
      onClick={onClick}
      disabled={disabled}
      title={shortcut ? `${label} (${shortcut})` : label}
    >
      <Icon name={icon} />
      <span className={iconOnly ? 'visually-hidden' : styles.toolLabel}>{label}</span>
    </button>
  );
}

/**
 * Interactive GLB viewer. Loads `sources` in order (e.g. the low-poly preview, then the full model),
 * keeping the camera after the first one so the swap is seamless.
 *
 * @param {{sources:{url:string,label:string}[], title:string, filename?:string, ar?:{usdz?:string|null, glb?:string|null}}} props
 */
export default function ModelViewer({ sources, title, filename = 'model', ar }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const coreRef = useRef(null);
  const [settings, setSettings] = useState({ wireframe: false, textures: true, ground: true, autoRotate: false, background: 'studio' });
  const [webgl] = useState(hasWebGL);
  const [load, setLoad] = useState(() =>
    webgl
      ? { phase: 'loading', label: sources[0]?.label, progress: null, error: null }
      : { phase: 'error', error: 'WebGL is not available in this browser, so the 3D preview can’t be shown. You can still download the model.' },
  );
  const [stats, setStats] = useState(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const sourceKey = sources.map((s) => s.url).join('|');

  // Create / dispose the three.js core.
  useEffect(() => {
    if (!webgl) return undefined;
    const core = new ViewerCore(canvasRef.current, { onChange: setSettings });
    coreRef.current = core;
    return () => {
      core.dispose();
      coreRef.current = null;
    };
  }, [webgl]);

  // Load sources in sequence.
  useEffect(() => {
    const core = coreRef.current;
    if (!core || !sourceKey) return undefined;
    let cancelled = false;
    const list = sourceKey.split('|').map((url, i) => ({ url, label: sources[i]?.label }));
    (async () => {
      let shownAny = false;
      for (let i = 0; i < list.length; i += 1) {
        const src = list[i];
        setLoad({ phase: shownAny ? 'refining' : 'loading', label: src.label, progress: null, error: null });
        try {
          const s = await core.load(src.url, {
            keepCamera: shownAny,
            onProgress: (p) => !cancelled && setLoad((l) => ({ ...l, progress: p })),
          });
          if (cancelled) return;
          if (s) setStats({ ...s, label: src.label });
          shownAny = true;
        } catch (err) {
          if (cancelled) return;
          // A failed preview is not fatal if the full model follows.
          if (i < list.length - 1) continue;
          if (!shownAny) {
            setLoad({ phase: 'error', error: `Couldn’t load the model (${err?.message || 'network error'}).` });
            return;
          }
        }
      }
      if (!cancelled) setLoad({ phase: 'ready', progress: 1, error: null });
    })();
    return () => {
      cancelled = true;
    };
    // `sources` labels are derived from the same key; reload only when URLs change or on retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, attempt]);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === wrapRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const set = useCallback((key, value) => coreRef.current?.set(key, value), []);
  const toggle = useCallback((key) => coreRef.current && set(key, !coreRef.current.state[key]), [set]);
  const cycleBackground = useCallback(() => {
    const cur = coreRef.current?.state.background ?? 'studio';
    set('background', BACKGROUNDS[(BACKGROUNDS.indexOf(cur) + 1) % BACKGROUNDS.length]);
  }, [set]);

  const toggleFullscreen = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.().catch(() => {});
  }, []);

  const screenshot = useCallback(() => {
    const url = coreRef.current?.screenshot();
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename.replace(/\.[^.]+$/, '')}-view.png`;
    a.click();
  }, [filename]);

  const onKeyDown = (e) => {
    if (e.target !== e.currentTarget && e.target.tagName === 'BUTTON') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const actions = {
      r: () => coreRef.current?.resetView(),
      a: () => toggle('autoRotate'),
      w: () => toggle('wireframe'),
      t: () => toggle('textures'),
      g: () => toggle('ground'),
      b: cycleBackground,
      f: toggleFullscreen,
      p: screenshot,
    };
    if (actions[k]) {
      e.preventDefault();
      actions[k]();
    }
  };

  const ready = load.phase === 'ready' || load.phase === 'refining';
  const pct = load.progress == null ? null : Math.round(load.progress * 100);

  return (
    <div ref={wrapRef} className={`${styles.wrap} ${fullscreen ? styles.isFullscreen : ''}`}>
      <div
        className={styles.stage}
        data-bg={settings.background}
        tabIndex={0}
        role="application"
        aria-roledescription="3D model viewer"
        aria-label={`${title}. Drag to orbit, scroll or pinch to zoom, right-drag to pan. Keys: R reset, A auto-rotate, W wireframe, T textures, G ground, B background, F fullscreen, P screenshot.`}
        onKeyDown={onKeyDown}
      >
        <div ref={canvasRef} className={styles.canvas} />

        {load.phase === 'loading' && (
          <div className={styles.overlay} role="status">
            <div className={styles.loader}>
              <span className="spinner" aria-hidden="true" />
              <span>
                Loading {load.label?.toLowerCase() ?? 'model'}
                {pct != null && <span className="mono"> {pct}%</span>}
              </span>
            </div>
            {pct != null && (
              <div className={`progress ${styles.loadBar}`}>
                <div className="progress__bar" style={{ width: `${pct}%` }} />
              </div>
            )}
          </div>
        )}
        {load.phase === 'refining' && (
          <div className={styles.pill} role="status">
            <span className="spinner" aria-hidden="true" />
            Loading full-resolution model{pct != null && <span className="mono"> {pct}%</span>}
          </div>
        )}
        {load.phase === 'error' && (
          <div className={styles.overlay} role="alert">
            <Icon name="alert" className={styles.errIcon} />
            <p>{load.error}</p>
            <button type="button" className="btn btn--sm" onClick={() => setAttempt((n) => n + 1)}>
              <Icon name="refresh" /> Retry
            </button>
          </div>
        )}

        {stats && ready && (
          <p className={`mono ${styles.hud}`} title={`${formatNumber(stats.triangles)} triangles, ${formatNumber(stats.vertices)} vertices`}>
            <span>{compactNumber(stats.triangles)} tris</span>
            <span>{compactNumber(stats.vertices)} verts</span>
            <span>{stats.materials} mat</span>
            <span className={styles.hudLabel}>{stats.label}</span>
          </p>
        )}
        <div className={styles.corner}>{ar && <ArButton usdz={ar.usdz} glb={ar.glb} title={title} />}</div>
      </div>

      <div className={styles.toolbar} role="toolbar" aria-label="Viewer controls">
        <ToolButton icon="rotate" label="Auto-rotate" shortcut="A" pressed={settings.autoRotate} onClick={() => toggle('autoRotate')} disabled={!ready} />
        <ToolButton icon="wire" label="Wireframe" shortcut="W" pressed={settings.wireframe} onClick={() => toggle('wireframe')} disabled={!ready} />
        <ToolButton icon="image" label="Texture" shortcut="T" pressed={settings.textures} onClick={() => toggle('textures')} disabled={!ready} />
        <ToolButton icon="grid" label="Ground" shortcut="G" pressed={settings.ground} onClick={() => toggle('ground')} disabled={!ready} />
        <ToolButton icon="sun" label={`BG: ${BG_LABEL[settings.background]}`} shortcut="B" onClick={cycleBackground} disabled={!ready} />
        <span className={styles.sep} aria-hidden="true" />
        <ToolButton icon="home" label="Reset view" iconOnly shortcut="R" onClick={() => coreRef.current?.resetView()} disabled={!ready} />
        <ToolButton icon="screenshot" label="Screenshot" iconOnly shortcut="P" onClick={screenshot} disabled={!ready} />
        <ToolButton icon={fullscreen ? 'shrink' : 'expand'} label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} iconOnly shortcut="F" onClick={toggleFullscreen} />
      </div>
    </div>
  );
}
