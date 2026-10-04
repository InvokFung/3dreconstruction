/**
 * Procedurally rendered "photos" for the mock samples: a simple object shot from a ring of cameras,
 * painted with a tiny software rasteriser on a 2D canvas.
 */

export const SAMPLES = [
  { name: 'vase', title: 'Ceramic vase', description: '36 turntable photos of a glazed vase. A clean, easy capture.', image_count: 36 },
  { name: 'box', title: 'Console box', description: '19 photos of a boxed game console on the floor.', image_count: 19 },
  { name: 'switch', title: 'Light switch', description: '18 photos of a wall switch. Flat and low-texture: a hard case.', image_count: 18 },
];

function cuboid(w, h, d, colors, decal) {
  const x = w / 2;
  const z = d / 2;
  const v = (a, b, c) => [a, b, c];
  return [
    { pts: [v(-x, 0, z), v(x, 0, z), v(x, h, z), v(-x, h, z)], color: colors.front, decal },
    { pts: [v(x, 0, -z), v(-x, 0, -z), v(-x, h, -z), v(x, h, -z)], color: colors.back },
    { pts: [v(x, 0, z), v(x, 0, -z), v(x, h, -z), v(x, h, z)], color: colors.side },
    { pts: [v(-x, 0, -z), v(-x, 0, z), v(-x, h, z), v(-x, h, -z)], color: colors.side },
    { pts: [v(-x, h, z), v(x, h, z), v(x, h, -z), v(-x, h, -z)], color: colors.top },
  ];
}

function lathe(profile, segments, colorAt) {
  const quads = [];
  for (let i = 0; i < segments; i += 1) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    for (let j = 0; j < profile.length - 1; j += 1) {
      const [r0, y0] = profile[j];
      const [r1, y1] = profile[j + 1];
      quads.push({
        pts: [
          [Math.cos(a0) * r0, y0, Math.sin(a0) * r0],
          [Math.cos(a1) * r0, y0, Math.sin(a1) * r0],
          [Math.cos(a1) * r1, y1, Math.sin(a1) * r1],
          [Math.cos(a0) * r1, y1, Math.sin(a0) * r1],
        ],
        color: colorAt(j / (profile.length - 1), i),
      });
    }
  }
  return quads;
}

const OBJECTS = {
  vase: () => ({
    quads: lathe(
      [[0.24, 0], [0.34, 0.12], [0.41, 0.33], [0.37, 0.52], [0.25, 0.68], [0.17, 0.8], [0.19, 0.93], [0.215, 0.97]],
      28,
      (t, i) => (t > 0.45 ? [47 + (i % 3) * 4, 111, 126] : t > 0.3 ? [217, 203, 176] : [180, 100, 60]),
    ),
    wall: ['#e9e4da', '#d8d1c3'],
    floor: ['#b9b2a4', '#8f887b'],
    arc: [0, Math.PI * 2],
    dist: 2.2,
    target: 0.45,
  }),
  box: () => ({
    quads: cuboid(1.5, 0.75, 0.32, { front: [38, 52, 70], back: [210, 205, 195], side: [24, 24, 26], top: [30, 30, 32] }, { color: [226, 33, 37], rect: [0.06, 0.62, 0.22, 0.9] }),
    wall: ['#ece8e1', '#dfd9cf'],
    floor: ['#d6d4cf', '#b8b5ae'],
    arc: [-1.1, 1.1],
    dist: 2.8,
    target: 0.35,
  }),
  switch: () => ({
    quads: [
      ...cuboid(0.7, 0.7, 0.05, { front: [244, 242, 236], back: [200, 200, 200], side: [225, 223, 216], top: [230, 228, 222] }),
      ...cuboid(0.12, 0.22, 0.14, { front: [250, 249, 245], back: [200, 200, 200], side: [215, 213, 206], top: [236, 234, 228] }).map((q) => ({
        ...q,
        pts: q.pts.map(([x, y, z]) => [x, y + 0.24, z + 0.07]),
      })),
    ],
    wall: ['#cfc6b6', '#c2b8a6'],
    floor: ['#cfc6b6', '#c2b8a6'],
    arc: [-0.9, 0.9],
    dist: 1.6,
    target: 0.35,
    noFloor: true,
  }),
};

const LIGHT = (() => {
  const l = [0.5, 0.8, 0.6];
  const n = Math.hypot(...l);
  return l.map((c) => c / n);
})();

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => {
  const n = Math.hypot(...a) || 1;
  return a.map((c) => c / n);
};
const lerp3 = (a, b, t) => a.map((c, i) => c + (b[i] - c) * t);

const cache = new Map();

/** Renders view `index` of `count` for a sample as a JPEG data URL. */
export function renderSampleImage(name, index, size = 384) {
  const key = `${name}:${index}:${size}`;
  if (cache.has(key)) return cache.get(key);
  const sample = SAMPLES.find((s) => s.name === name) ?? SAMPLES[0];
  const def = (OBJECTS[sample.name] ?? OBJECTS.vase)();
  const count = sample.image_count;
  const w = size;
  const h = Math.round(size * 0.75);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');

  const t = count > 1 ? index / (def.arc[1] - def.arc[0] >= Math.PI * 2 - 0.01 ? count : count - 1) : 0;
  const az = def.arc[0] + (def.arc[1] - def.arc[0]) * t;
  const el = 0.32 + 0.12 * Math.sin(index * 1.3);
  const eye = [Math.sin(az) * Math.cos(el) * def.dist, def.target + Math.sin(el) * def.dist, Math.cos(az) * Math.cos(el) * def.dist];
  const target = [0, def.target, 0];
  const fwd = norm(sub(target, eye));
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  const f = h * 1.25;
  const project = (p) => {
    const d = sub(p, eye);
    const z = dot(d, fwd);
    return [w / 2 + (dot(d, right) * f) / z, h / 2 - (dot(d, up) * f) / z, z];
  };

  // background
  const horizon = def.noFloor ? h : h * (0.5 + 0.1 * Math.sin(el * 3));
  const wall = g.createLinearGradient(0, 0, 0, horizon);
  wall.addColorStop(0, def.wall[0]);
  wall.addColorStop(1, def.wall[1]);
  g.fillStyle = wall;
  g.fillRect(0, 0, w, horizon);
  if (!def.noFloor) {
    const floor = g.createLinearGradient(0, horizon, 0, h);
    floor.addColorStop(0, def.floor[0]);
    floor.addColorStop(1, def.floor[1]);
    g.fillStyle = floor;
    g.fillRect(0, horizon, w, h - horizon);
    // contact shadow
    const c = project([0, 0, 0]);
    g.fillStyle = 'rgba(0,0,0,0.22)';
    g.beginPath();
    g.ellipse(c[0], c[1], w * 0.22, w * 0.05, 0, 0, Math.PI * 2);
    g.fill();
  }

  // faces, back-to-front
  const faces = def.quads
    .map((q) => {
      const n = norm(cross(sub(q.pts[1], q.pts[0]), sub(q.pts[3], q.pts[0])));
      const centre = q.pts.reduce((a, p) => a.map((c, i) => c + p[i] / q.pts.length), [0, 0, 0]);
      return { q, n, depth: dot(sub(centre, eye), fwd), facing: dot(n, sub(eye, centre)) > 0 };
    })
    .filter((f) => f.facing)
    .sort((a, b) => b.depth - a.depth);

  const fill = (pts, rgb) => {
    g.fillStyle = `rgb(${rgb.map((c) => Math.round(Math.max(0, Math.min(255, c)))).join(',')})`;
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
    g.closePath();
    g.fill();
    g.strokeStyle = g.fillStyle;
    g.lineWidth = 0.6;
    g.stroke();
  };

  for (const { q, n } of faces) {
    const shade = 0.45 + 0.6 * Math.max(0, dot(n, LIGHT));
    fill(q.pts.map(project), q.color.map((c) => c * shade));
    if (q.decal) {
      const [u0, v0, u1, v1] = q.decal.rect;
      const [a, b, , d] = q.pts;
      const at = (u, v) => lerp3(lerp3(a, b, u), lerp3(d, q.pts[2], u), v);
      fill([at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)].map(project), q.decal.color.map((c) => c * shade));
    }
  }

  // sensor noise so it looks a bit like a photo
  const img = g.getImageData(0, 0, w, h);
  let s = index * 977 + 13;
  for (let i = 0; i < img.data.length; i += 4) {
    s = (s * 16807) % 2147483647;
    const nz = ((s / 2147483647) - 0.5) * 10;
    img.data[i] += nz;
    img.data[i + 1] += nz;
    img.data[i + 2] += nz;
  }
  g.putImageData(img, 0, 0);

  const url = canvas.toDataURL('image/jpeg', 0.82);
  cache.set(key, url);
  return url;
}
