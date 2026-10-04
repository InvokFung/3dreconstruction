import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export const BACKGROUNDS = ['studio', 'environment', 'dark', 'light'];

const TEXTURE_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'];

function disposeObject(root) {
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.geometry?.dispose();
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (!m) continue;
      for (const slot of TEXTURE_SLOTS) {
        m[slot]?.dispose?.();
        m.userData.originalMaps?.[slot]?.dispose?.();
      }
      m.dispose();
    }
  });
}

/**
 * Imperative three.js viewer: renderer, environment lighting, orbit controls, ground and loading.
 * Kept free of React so it can be reasoned about (and disposed) in one place.
 */
export class ViewerCore {
  constructor(container, { onChange } = {}) {
    this.container = container;
    this.onChange = onChange;
    this.state = { wireframe: false, textures: true, ground: true, autoRotate: false, background: 'studio' };

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.touchAction = 'none';
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    this.scene = scene;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envTexture = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = this.envTexture;

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
    this.camera.position.set(2, 1.5, 2.5);

    const controls = new OrbitControls(this.camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotateSpeed = 1.4;
    controls.screenSpacePanning = true;
    this.controls = controls;

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    scene.add(key, key.target);
    this.keyLight = key;

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.22 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    scene.add(this.ground);

    this.grid = new THREE.GridHelper(1, 20, 0x888888, 0x888888);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.18;
    this.grid.material.depthWrite = false;
    scene.add(this.grid);

    this.pivot = new THREE.Group();
    scene.add(this.pivot);
    this.model = null;
    this.loadSeq = 0;
    this.home = null;

    this.loader = new GLTFLoader();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    this.visible = true;
    this.intersection = new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting;
    });
    this.intersection.observe(container);

    renderer.setAnimationLoop(() => {
      if (!this.visible) return;
      controls.update();
      renderer.render(scene, this.camera);
    });
    this.applyBackground();
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Loads a GLB/glTF. Later calls win over earlier ones still in flight.
   * @param {string} url
   * @param {{onProgress?:(f:number|null)=>void, keepCamera?:boolean}} [opts]
   */
  async load(url, { onProgress, keepCamera = false } = {}) {
    const seq = ++this.loadSeq;
    const gltf = await this.loader.loadAsync(url, (e) => onProgress?.(e.lengthComputable && e.total ? e.loaded / e.total : null));
    if (seq !== this.loadSeq || !this.renderer) {
      disposeObject(gltf.scene);
      return null;
    }
    const root = gltf.scene;
    root.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    if (this.model) {
      this.pivot.remove(this.model);
      disposeObject(this.model);
    }
    this.model = root;
    this.pivot.add(root);
    this.applyMaterialState();
    this.frame(keepCamera && this.home);
    return this.stats();
  }

  /** Centers the model on the ground plane and (optionally) moves the camera to fit it. */
  frame(keepCamera) {
    const root = this.model;
    if (!root) return;
    root.position.set(0, 0, 0);
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    root.position.set(-center.x, -box.min.y, -center.z);

    const radius = Math.max(size.length() / 2, 1e-3);
    const target = new THREE.Vector3(0, size.y / 2, 0);

    // ground, grid and light scale with the model
    this.ground.scale.setScalar(radius * 8);
    this.grid.scale.setScalar(radius * 4);
    this.grid.position.y = 0.0005 * radius;
    const light = this.keyLight;
    light.position.set(radius * 1.5, radius * 3.5, radius * 2);
    light.target.position.copy(target);
    const cam = light.shadow.camera;
    cam.left = cam.bottom = -radius * 1.6;
    cam.right = cam.top = radius * 1.6;
    cam.near = radius * 0.1;
    cam.far = radius * 10;
    cam.updateProjectionMatrix();

    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const fitHeight = radius / Math.sin(fov / 2);
    const fitWidth = fitHeight / Math.min(1, this.camera.aspect);
    const dist = Math.max(fitHeight, fitWidth) * 0.95;
    this.camera.near = dist / 200;
    this.camera.far = dist * 50;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = radius * 0.3;
    this.controls.maxDistance = dist * 5;

    const dir = new THREE.Vector3(0.65, 0.42, 0.85).normalize();
    this.home = { position: target.clone().addScaledVector(dir, dist), target };
    if (!keepCamera) this.resetView();
  }

  resetView() {
    if (!this.home) return;
    this.camera.position.copy(this.home.position);
    this.controls.target.copy(this.home.target);
    this.controls.update();
  }

  forEachMaterial(fn) {
    this.model?.traverse((o) => {
      if (!o.isMesh) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m && fn(m));
    });
  }

  applyMaterialState() {
    const { wireframe, textures } = this.state;
    this.forEachMaterial((m) => {
      if (!m.userData.originalMaps) {
        m.userData.originalMaps = Object.fromEntries(TEXTURE_SLOTS.map((s) => [s, m[s] ?? null]));
      }
      for (const slot of TEXTURE_SLOTS) {
        if (slot === 'normalMap' || slot === 'aoMap') continue; // keep shape detail
        m[slot] = textures ? m.userData.originalMaps[slot] : null;
      }
      m.wireframe = wireframe;
      m.needsUpdate = true;
    });
  }

  set(key, value) {
    this.state = { ...this.state, [key]: value };
    if (key === 'wireframe' || key === 'textures') this.applyMaterialState();
    if (key === 'ground') {
      this.ground.visible = value;
      this.grid.visible = value;
    }
    if (key === 'autoRotate') this.controls.autoRotate = value;
    if (key === 'background') this.applyBackground();
    this.onChange?.(this.state);
  }

  applyBackground() {
    const bg = this.state.background;
    const scene = this.scene;
    scene.backgroundBlurriness = 0;
    if (bg === 'environment') {
      scene.background = this.envTexture;
      scene.backgroundBlurriness = 0.6;
      scene.backgroundIntensity = 0.9;
    } else if (bg === 'dark') scene.background = new THREE.Color(0x101113);
    else if (bg === 'light') scene.background = new THREE.Color(0xf3f1ec);
    else scene.background = null; // transparent: the CSS gradient behind shows through
    this.grid.material.color.set(bg === 'dark' ? 0x5a5a5a : 0x888888);
  }

  stats() {
    let triangles = 0;
    let vertices = 0;
    const materials = new Set();
    let textured = false;
    this.model?.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry;
      const count = g.index ? g.index.count : g.attributes.position?.count ?? 0;
      triangles += Math.floor(count / 3);
      vertices += g.attributes.position?.count ?? 0;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
        materials.add(m);
        if (m?.userData.originalMaps?.map) textured = true;
      });
    });
    return { triangles, vertices, materials: materials.size, textured };
  }

  /** PNG data URL of the current view (rendered on demand, no preserveDrawingBuffer needed). */
  screenshot() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  dispose() {
    this.loadSeq += 1;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.intersection.disconnect();
    this.controls.dispose();
    if (this.model) disposeObject(this.model);
    this.ground.geometry.dispose();
    this.ground.material.dispose();
    this.grid.geometry.dispose();
    this.grid.material.dispose();
    this.envTexture.dispose();
    this.pmrem.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    this.renderer.domElement.remove();
    this.renderer = null;
  }
}
