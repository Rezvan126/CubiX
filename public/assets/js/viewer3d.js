/* CubiX 3D viewer for previews: rotate, zoom, and numbered pins.
   mount(el, { url, name, pins, editable, onChange }) returns { setPins, focusPin, destroy }.
   Pins are stored in the model's own coordinates, so they land on the same spot for everyone. */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

export const MODEL_EXT = ['stl', 'obj', '3mf', 'glb', 'gltf'];
export const isModel = name => MODEL_EXT.includes(String(name || '').split('.').pop().toLowerCase());

async function loadObject(url, name) {
  const ext = String(name).split('.').pop().toLowerCase();
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('The model could not be loaded.');
  const buf = await res.arrayBuffer();
  const mat = new THREE.MeshStandardMaterial({ color: 0xd9d6e6, roughness: 0.62, metalness: 0.04 });
  if (ext === 'stl') { const g = new STLLoader().parse(buf); g.computeVertexNormals(); return new THREE.Mesh(g, mat); }
  if (ext === 'obj') { const o = new OBJLoader().parse(new TextDecoder().decode(buf)); o.traverse(c => { if (c.isMesh) c.material = mat; }); return o; }
  if (ext === '3mf') { const o = new ThreeMFLoader().parse(buf); o.traverse(c => { if (c.isMesh && (!c.material || !c.material.color)) c.material = mat; }); return o; }
  const l = new GLTFLoader(); l.setMeshoptDecoder(MeshoptDecoder);
  return await new Promise((ok, no) => l.parse(buf, '', g => ok(g.scene), no));
}

export function mount(el, { url, name, pins = [], editable = false, onChange } = {}) {
  el.classList.add('v3d');
  el.innerHTML = `<div class="v3d-stage"><canvas></canvas><div class="v3d-pins"></div><div class="v3d-msg">Loading 3D model</div></div>
    <div class="v3d-bar"><span class="v3d-hint">${editable ? 'Drag to rotate, scroll to zoom. Click the model to drop a pin.' : 'Drag to rotate, scroll or pinch to zoom.'}</span><button type="button" class="v3d-reset">Reset view</button></div>`;
  const stage = el.querySelector('.v3d-stage'), canvas = el.querySelector('canvas'), layer = el.querySelector('.v3d-pins'), msg = el.querySelector('.v3d-msg');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 5000);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a87a8, 1.15));
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(3, 5, 4); scene.add(key);
  const rim = new THREE.DirectionalLight(0xc4b5fd, 0.6); rim.position.set(-4, 2, -3); scene.add(rim);
  const controls = new OrbitControls(camera, canvas); controls.enableDamping = true;
  const root = new THREE.Group(); scene.add(root);
  let model = null, home = null, alive = true, list = pins.map((p, i) => ({ n: i + 1, p: p.p, note: p.note || '' }));

  const size = () => { const w = stage.clientWidth, h = stage.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix(); };
  const ro = new ResizeObserver(size); ro.observe(stage); size();

  function drawPins() {
    layer.innerHTML = list.map(p => `<button type="button" class="v3d-pin" data-n="${p.n}" title="${(p.note || 'Pin ' + p.n).replace(/"/g, '&quot;')}">${p.n}</button>`).join('');
  }
  function placePins() {
    if (!model) return;
    const w = stage.clientWidth, h = stage.clientHeight, v = new THREE.Vector3();
    layer.querySelectorAll('.v3d-pin').forEach(b => {
      const p = list.find(x => x.n === +b.dataset.n); if (!p) return;
      v.set(p.p[0], p.p[1], p.p[2]); model.localToWorld(v); v.project(camera);
      const hidden = v.z > 1;
      b.style.transform = `translate(${(v.x + 1) / 2 * w}px, ${(1 - v.y) / 2 * h}px) translate(-50%, -100%)`;
      b.style.opacity = hidden ? 0 : 1;
    });
  }
  const loop = () => { if (!alive) return; if (!canvas.isConnected) { api.destroy(); return; } controls.update(); renderer.render(scene, camera); placePins(); requestAnimationFrame(loop); };

  loadObject(url, name).then(obj => {
    if (!alive) return;
    model = obj; root.add(model);
    const box = new THREE.Box3().setFromObject(model), c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    const r = Math.max(s.x, s.y, s.z) || 1;
    // Print files are usually Z up; turn them so they stand upright in the viewer.
    if (/\.(stl|3mf)$/i.test(name)) root.rotation.x = -Math.PI / 2;
    root.position.set(0, 0, 0); model.position.sub(c);
    const d = r * 1.9; camera.position.set(d * 0.8, d * 0.55, d); camera.near = r / 100; camera.far = r * 100; camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0); controls.update(); home = camera.position.clone();
    msg.hidden = true; drawPins(); loop();
  }).catch(e => { msg.textContent = e.message || 'The model could not be shown. Download it instead.'; });

  el.querySelector('.v3d-reset').addEventListener('click', () => { if (home) { camera.position.copy(home); controls.target.set(0, 0, 0); controls.update(); } });

  // a click (not a drag) on the model drops a pin
  let down = null;
  canvas.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', e => {
    if (!editable || !model || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const rect = canvas.getBoundingClientRect();
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1), camera);
    const hit = ray.intersectObject(model, true)[0];
    if (!hit) return;
    const local = model.worldToLocal(hit.point.clone());
    if (list.length >= 30) return;
    list.push({ n: list.length + 1, p: [local.x, local.y, local.z].map(n => Math.round(n * 1000) / 1000), note: '' });
    drawPins(); onChange && onChange(list.slice());
  });
  layer.addEventListener('click', e => { const b = e.target.closest('.v3d-pin'); if (b) el.dispatchEvent(new CustomEvent('pin', { detail: +b.dataset.n })); });

  const api = {
    setPins(next) { list = next.map((p, i) => ({ n: i + 1, p: p.p, note: p.note || '' })); drawPins(); },
    focusPin(n) {
      const p = list.find(x => x.n === n); if (!p || !model) return;
      const v = new THREE.Vector3(...p.p); model.localToWorld(v);
      const dir = camera.position.clone().sub(controls.target).normalize(), dist = camera.position.distanceTo(controls.target) * 0.7;
      controls.target.copy(v); camera.position.copy(v.clone().add(dir.multiplyScalar(dist))); controls.update();
      const b = layer.querySelector(`[data-n="${n}"]`); if (b) { b.classList.add('on'); setTimeout(() => b.classList.remove('on'), 1600); }
    },
    destroy() { if (!alive) return; alive = false; ro.disconnect(); controls.dispose(); renderer.dispose(); },
  };
  return api;
}
