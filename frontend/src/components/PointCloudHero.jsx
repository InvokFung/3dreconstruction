import { useEffect, useRef } from 'react';

/*
 * A lightweight 2D-canvas hero: a point cloud of a vase being "reconstructed" by a sweeping scan
 * plane, surrounded by the camera poses that captured it. No three.js, so the landing page stays small.
 */

function makePoints(count = 1500) {
  const pts = [];
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < count; i += 1) {
    const y = rand() * 2 - 1; // -1 bottom .. 1 top
    const t = (y + 1) / 2;
    const r = 0.28 + 0.34 * Math.sin(t * Math.PI * 0.95 + 0.25) ** 1.6 - 0.12 * t + (t > 0.86 ? (t - 0.86) * 1.4 : 0);
    const a = rand() * Math.PI * 2;
    const j = (rand() - 0.5) * 0.025;
    pts.push({ x: Math.cos(a) * (r + j), y: y * 0.95, z: Math.sin(a) * (r + j), hot: rand() < 0.07 });
  }
  // a disc of points on the ground (the "turntable")
  for (let i = 0; i < 260; i += 1) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * 0.95;
    pts.push({ x: Math.cos(a) * r, y: -1.0, z: Math.sin(a) * r, ground: true });
  }
  return pts;
}

const CAMERAS = Array.from({ length: 9 }, (_, i) => ({ a: (i / 9) * Math.PI * 2, y: 0.25 + 0.35 * Math.sin(i * 1.7) }));

export default function PointCloudHero({ className }) {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    const points = makePoints();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let colors = {};
    let w = 0;
    let h = 0;
    let raf = 0;
    let visible = true;
    const start = performance.now();

    const readColors = () => {
      const cs = getComputedStyle(canvas);
      colors = {
        ink: cs.getPropertyValue('--ink').trim() || '#16150f',
        muted: cs.getPropertyValue('--muted').trim() || '#888',
        accent: cs.getPropertyValue('--accent').trim() || '#f0480f',
        cyan: cs.getPropertyValue('--cyan').trim() || '#0a7f8f',
        line: cs.getPropertyValue('--line-strong').trim() || '#ccc',
      };
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      readColors();
      if (reduced) draw(4200);
    };

    const tilt = 0.32;
    const cosT = Math.cos(tilt);
    const sinT = Math.sin(tilt);

    const project = (x, y, z, rot) => {
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      const rx = x * c - z * s;
      const rz = x * s + z * c;
      const ry = y * cosT - rz * sinT;
      const rz2 = y * sinT + rz * cosT;
      const scale = Math.min(w, h) * 0.36;
      const persp = 3.2 / (3.2 + rz2);
      return { x: w / 2 + rx * scale * persp, y: h * 0.52 - ry * scale * persp, z: rz2, p: persp };
    };

    function draw(t) {
      ctx.clearRect(0, 0, w, h);
      const rot = t * 0.00022;
      const cycle = 7000;
      const phase = (t % cycle) / cycle;
      const sweep = -1.15 + phase * 2.6; // scan plane height

      // camera frustums
      ctx.lineWidth = 1;
      for (const cam of CAMERAS) {
        const cx = Math.cos(cam.a) * 1.7;
        const cz = Math.sin(cam.a) * 1.7;
        const p = project(cx, cam.y, cz, rot);
        const target = project(0, 0, 0, rot);
        const alpha = p.z < 0 ? 0.55 : 0.22;
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = colors.cyan;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + (target.x - p.x) * 0.35, p.y + (target.y - p.y) * 0.35);
        ctx.stroke();
        ctx.setLineDash([]);
        const s = 7 * p.p;
        ctx.strokeRect(p.x - s, p.y - s * 0.7, s * 2, s * 1.4);
        ctx.fillStyle = colors.cyan;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }

      // points (painter's order is unnecessary at this density)
      for (const pt of points) {
        const p = project(pt.x, pt.y, pt.z, rot);
        const scanned = pt.y < sweep;
        const front = p.z < 0;
        let r = (pt.ground ? 0.9 : 1.25) * p.p;
        if (!scanned) {
          ctx.globalAlpha = pt.ground ? 0.12 : 0.16;
          ctx.fillStyle = colors.muted;
        } else if (pt.hot) {
          ctx.globalAlpha = 0.95;
          ctx.fillStyle = colors.accent;
          r *= 1.5;
        } else {
          ctx.globalAlpha = pt.ground ? 0.35 : front ? 0.9 : 0.45;
          ctx.fillStyle = colors.ink;
        }
        ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
      }

      // scan plane
      if (sweep > -1.05 && sweep < 1.0) {
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = colors.accent;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        for (let i = 0; i <= 48; i += 1) {
          const a = (i / 48) * Math.PI * 2;
          const p = project(Math.cos(a) * 0.78, sweep, Math.sin(a) * 0.78, rot);
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    const loop = (now) => {
      if (visible) draw(now - start);
      raf = requestAnimationFrame(loop);
    };

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
    });
    io.observe(canvas);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => {
      readColors();
      if (reduced) draw(4200);
    };
    mq.addEventListener('change', onScheme);
    resize();
    if (!reduced) raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      mq.removeEventListener('change', onScheme);
    };
  }, []);

  return <canvas ref={ref} className={className} role="img" aria-label="Animated point cloud of a vase being reconstructed from camera views" />;
}
