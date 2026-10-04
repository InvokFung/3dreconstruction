/**
 * Builds the mock "reconstruction": a glazed ceramic vase on a wooden turntable, generated with
 * three.js and exported at runtime to real GLB / preview GLB / OBJ (zip) / PLY / USDZ files.
 */
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { PLYExporter } from 'three/addons/exporters/PLYExporter.js';
import { USDZExporter } from 'three/addons/exporters/USDZExporter.js';
import { strToU8, zipSync } from 'three/addons/libs/fflate.module.js';

function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

function glazeTexture(size = 1024) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  // v=0 is the bottom of the lathe profile, canvas y=0 is the top of the image (flipY applies)
  const grad = g.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, '#1f4e5f');
  grad.addColorStop(0.35, '#2f6f7e');
  grad.addColorStop(0.55, '#d9cbb0');
  grad.addColorStop(1, '#b4643c');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const r = rng(11);
  // glaze drips
  for (let i = 0; i < 70; i += 1) {
    const x = r() * size;
    const len = size * (0.25 + r() * 0.3);
    const w = 6 + r() * 16;
    const dg = g.createLinearGradient(0, size * 0.3, 0, size * 0.3 + len);
    dg.addColorStop(0, 'rgba(36,92,108,0.95)');
    dg.addColorStop(1, 'rgba(36,92,108,0)');
    g.fillStyle = dg;
    g.beginPath();
    g.roundRect(x, size * 0.28, w, len, w / 2);
    g.fill();
  }
  // incised band
  g.fillStyle = 'rgba(40,24,14,0.55)';
  for (let x = 0; x < size; x += 32) {
    g.beginPath();
    g.moveTo(x, size * 0.66);
    g.lineTo(x + 16, size * 0.7);
    g.lineTo(x + 32, size * 0.66);
    g.lineTo(x + 32, size * 0.672);
    g.lineTo(x + 16, size * 0.712);
    g.lineTo(x, size * 0.672);
    g.fill();
  }
  // speckles
  for (let i = 0; i < 5000; i += 1) {
    g.fillStyle = `rgba(${r() < 0.5 ? '30,20,10' : '255,250,240'},${0.15 + r() * 0.25})`;
    g.fillRect(r() * size, r() * size, 1 + r() * 2, 1 + r() * 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

function woodTexture(size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#9a6a3f';
  g.fillRect(0, 0, size, size);
  const r = rng(5);
  for (let i = 0; i < 90; i += 1) {
    const rad = (i / 90) * size * 0.7;
    g.strokeStyle = `rgba(${60 + r() * 30},${36 + r() * 20},${18},${0.15 + r() * 0.25})`;
    g.lineWidth = 1 + r() * 3;
    g.beginPath();
    g.ellipse(size / 2, size / 2, rad, rad * (0.96 + r() * 0.06), 0, 0, Math.PI * 2);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function vaseProfile() {
  const pts = [
    [0.0, 0.0],
    [0.24, 0.0],
    [0.27, 0.02],
    [0.34, 0.12],
    [0.4, 0.28],
    [0.41, 0.38],
    [0.37, 0.52],
    [0.27, 0.66],
    [0.18, 0.76],
    [0.165, 0.84],
    [0.19, 0.93],
    [0.215, 0.96],
    [0.2, 0.975],
    [0.17, 0.95],
    [0.145, 0.84],
    [0.15, 0.76],
    [0.0, 0.7],
  ];
  return pts.map(([x, y]) => new THREE.Vector2(x, y));
}

function buildScene({ detail }) {
  const scene = new THREE.Scene();
  const hi = detail === 'full';
  const vaseGeo = new THREE.LatheGeometry(vaseProfile(), hi ? 128 : 18);
  if (hi) {
    // subtle hand-thrown wobble so it reads as a scan, not a CAD primitive
    const pos = vaseGeo.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i += 1) {
      v.fromBufferAttribute(pos, i);
      const a = Math.atan2(v.z, v.x);
      const k = 1 + 0.012 * Math.sin(a * 3 + v.y * 9) + 0.006 * Math.sin(v.y * 40);
      pos.setXYZ(i, v.x * k, v.y, v.z * k);
    }
    vaseGeo.computeVertexNormals();
  }
  const vaseMat = hi
    ? new THREE.MeshStandardMaterial({ map: glazeTexture(), roughness: 0.32, metalness: 0, name: 'glaze' })
    : new THREE.MeshStandardMaterial({ color: 0x6f8f8f, roughness: 0.5, name: 'preview' });
  const vase = new THREE.Mesh(vaseGeo, vaseMat);
  vase.name = 'vase';
  vase.position.y = 0.04;

  const baseGeo = new THREE.CylinderGeometry(0.55, 0.57, 0.04, hi ? 96 : 16);
  const baseMat = hi
    ? new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.7, name: 'wood' })
    : new THREE.MeshStandardMaterial({ color: 0x9a6a3f, roughness: 0.8, name: 'preview-wood' });
  const base = new THREE.Mesh(baseGeo, baseMat);
  base.name = 'turntable';
  base.position.y = 0.02;

  const group = new THREE.Group();
  group.name = 'reconstruction';
  group.add(base, vase);
  // exporters expect unit-length normals
  for (const g of [vaseGeo, baseGeo]) {
    const n = g.attributes.normal;
    const v = new THREE.Vector3();
    for (let i = 0; i < n.count; i += 1) {
      v.fromBufferAttribute(n, i);
      if (v.lengthSq() < 1e-8) v.set(0, 1, 0);
      v.normalize();
      n.setXYZ(i, v.x, v.y, v.z);
    }
  }
  scene.add(group);
  return scene;
}

const toBlob = (data, type) => new Blob([data], { type });

/** @returns {Promise<Record<string, Blob>>} keyed by artifact kind */
export async function buildDemoAssets() {
  const full = buildScene({ detail: 'full' });
  const preview = buildScene({ detail: 'preview' });
  const gltf = new GLTFExporter();
  const out = {};
  out.glb = toBlob(await gltf.parseAsync(full, { binary: true }), 'model/gltf-binary');
  out.preview = toBlob(await gltf.parseAsync(preview, { binary: true }), 'model/gltf-binary');
  try {
    const obj = new OBJExporter().parse(full);
    const zip = zipSync({ 'model.obj': strToU8(obj), 'README.txt': strToU8('WebRecon demo export (mock mode).\n') });
    out.obj_zip = toBlob(zip, 'application/zip');
  } catch {
    /* optional */
  }
  try {
    const ply = await new Promise((resolve) => new PLYExporter().parse(full, resolve, { binary: true }));
    out.ply = toBlob(ply, 'application/octet-stream');
  } catch {
    /* optional */
  }
  try {
    const usdz = await new USDZExporter().parseAsync(full);
    out.usdz = toBlob(usdz, 'model/vnd.usdz+zip');
  } catch {
    /* optional */
  }
  return out;
}
