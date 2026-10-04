import Icon from '../ui/Icon.jsx';
import styles from './ModelViewer.module.css';

// Quick Look requires an <img> as the first child of <a rel="ar">.
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

function platform() {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (iOS) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'other';
}

function quickLookSupported() {
  try {
    return document.createElement('a').relList.supports('ar');
  } catch {
    return false;
  }
}

/**
 * "View in your room": AR Quick Look (USDZ) on iOS, Scene Viewer (GLB) on Android.
 * Renders nothing on desktop browsers, where neither is available.
 */
export default function ArButton({ usdz, glb, title }) {
  const os = platform();
  if (os === 'ios' && usdz && quickLookSupported()) {
    return (
      <a rel="ar" href={usdz} className={`btn btn--sm ${styles.arBtn}`}>
        <img src={PIXEL} alt="" width="1" height="1" style={{ position: 'absolute', opacity: 0 }} />
        <Icon name="ar" /> View in your room
      </a>
    );
  }
  if (os === 'android' && glb && !glb.startsWith('blob:')) {
    const file = new URL(glb, window.location.href).href;
    const fallback = encodeURIComponent(window.location.href);
    const href =
      `intent://arvr.google.com/scene-viewer/1.0?file=${encodeURIComponent(file)}&mode=ar_preferred&title=${encodeURIComponent(title)}` +
      `#Intent;scheme=https;package=com.google.android.googlequicksearchbox;action=android.intent.action.VIEW;S.browser_fallback_url=${fallback};end;`;
    return (
      <a href={href} className={`btn btn--sm ${styles.arBtn}`}>
        <Icon name="ar" /> View in your room
      </a>
    );
  }
  return null;
}
