import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const MODELS = [
  { f: 'p02', t: 'Brick Georgian colonial', s: 'STL · from customer photos', z: 'Scaled', az: 45 },
  { f: 'p07', t: 'Stone French country lantern', s: 'STL · window cutouts for LED', z: '229 mm', az: 20 },
  { f: 'p17', t: 'Gothic stone church', s: 'STL · patterned stonework', z: 'Landmark', az: 45 },
  { f: 'p00', t: 'Colonial keepsake', s: 'STL · deck and porch detail', z: '127 mm', az: 45 },
  { f: 'p04', t: 'Plantation home with double porch', s: 'STL · LED lantern', z: '229 mm', az: 45 },
];

function start() {
  const box = $('#viewer'), canvas = $('#stage'), loadEl = $('#vLoad');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.82;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
  scene.environmentIntensity = 0.22;

  const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 100);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.dampingFactor = 0.06; controls.enablePan = false;
  controls.minDistance = 3; controls.maxDistance = 14;
  controls.minPolarAngle = Math.PI * 0.12; controls.maxPolarAngle = Math.PI * 0.47;
  controls.autoRotate = !reduceMotion; controls.autoRotateSpeed = 0.6;
  let idle;
  controls.addEventListener('start', () => { controls.autoRotate = false; clearTimeout(idle); });
  controls.addEventListener('end', () => { idle = setTimeout(() => { controls.autoRotate = !reduceMotion; }, 4000); });

  const key = new THREE.DirectionalLight(0xffffff, 2.3);
  key.position.set(3, 5, 3.5); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -2.5, right: 2.5, top: 2.5, bottom: -2.5, near: 0.1, far: 20 });
  key.shadow.bias = -0.0004; key.shadow.normalBias = 0.01; key.shadow.radius = 5;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xdfe6f5, 0.55); fill.position.set(-4, 2.5, -2); scene.add(fill);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a93a0, 0.3));

  const ground = new THREE.Mesh(new THREE.CircleGeometry(4, 64), new THREE.ShadowMaterial({ opacity: 0.28 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

  const mat = new THREE.MeshStandardMaterial({ color: 0xcfcac2, roughness: 0.75, metalness: 0 });
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const cache = new Map();
  let current = null, shown = 0, token = 0;

  function getModel(i) {
    if (cache.has(i)) return cache.get(i);
    const url = `assets/models/${MODELS[i].f}.glb`;
    const p = loader.loadAsync(url).catch(() => loader.loadAsync(url + ".wasm")).then(g => {
      const grp = new THREE.Group();
      g.scene.traverse(o => { if (o.isMesh) { o.material = mat; o.castShadow = true; o.receiveShadow = true; o.geometry.computeVertexNormals(); } });
      const b = new THREE.Box3().setFromObject(g.scene), size = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
      const s = 2.1 / Math.max(size.x, size.y, size.z);
      g.scene.position.set(-c.x, -b.min.y, -c.z);
      grp.add(g.scene); grp.scale.setScalar(s);
      grp.userData = { h: size.y * s, r: size.clone().multiplyScalar(s).length() / 2, s };
      return grp;
    });
    cache.set(i, p);
    return p;
  }

  function frame(m, cfg) {
    const a = THREE.MathUtils.degToRad(cfg.az), el = 0.42;
    const vf = THREE.MathUtils.degToRad(camera.fov), hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect);
    const portrait = camera.aspect < 0.9;
    const d = m.userData.r / Math.sin(Math.min(vf, hf) / 2) * (portrait ? 1.0 : 1.1);
    const ty = portrait ? -m.userData.h * 0.08 : m.userData.h * 0.1;
    controls.target.set(0, ty, 0);
    camera.position.set(Math.sin(a) * d * Math.cos(el), ty + d * Math.sin(el), Math.cos(a) * d * Math.cos(el));
  }

  async function show(i) {
    shown = i; const my = ++token;
    loadEl.classList.remove('done');
    const m = await getModel(i);
    if (my !== token) return;
    if (current) scene.remove(current);
    current = m; scene.add(m); loadEl.classList.add('done');
    frame(m, MODELS[i]);
    $('#vTitle').textContent = MODELS[i].t;
    $('#vSub').textContent = MODELS[i].s;
    $('#vSize').textContent = MODELS[i].z;
    if (!reduceMotion) {
      const s0 = m.userData.s, t0 = performance.now();
      const grow = t => { const k = Math.min(1, (t - t0) / 500); m.scale.setScalar(s0 * (0.94 + 0.06 * (1 - Math.pow(1 - k, 3)))); if (k < 1) requestAnimationFrame(grow); };
      requestAnimationFrame(grow);
    }
  }

  $$('.v-tabs button').forEach(b => b.addEventListener('click', () => {
    $$('.v-tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    show(+b.dataset.m);
  }));

  const resize = () => {
    const w = box.clientWidth, h = box.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    if (current) frame(current, MODELS[shown]);
  };
  new ResizeObserver(resize).observe(box); resize();

  let visible = true;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(box);
  renderer.setAnimationLoop(() => { if (visible) { controls.update(); renderer.render(scene, camera); } });

  return show(0).then(() => {
    const warm = () => MODELS.forEach((_, i) => i && getModel(i));
    (window.requestIdleCallback || setTimeout)(warm);
  });
}

try {
  Promise.resolve(start()).catch(() => window.viewerFallback && window.viewerFallback());
} catch {
  window.viewerFallback && window.viewerFallback();
}
