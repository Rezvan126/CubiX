/* CubiX 3D viewer for previews.
   mount(el, { files: [{ url, name }], pins, comment, onPick, onPinClick }) returns { setPins, focusPin, showTemp, clearTemp, destroy }.
   - Several part files (ground floor, upper floor, roof) load together in their real positions.
   - Parts can be shown or hidden, and a height cut slices through the building to check each level.
   - Pins sit in the model's own coordinates and remember the part they are on, so they land on the same spot for everyone. */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

export const MODEL_EXT = ['stl', 'obj', '3mf', 'glb', 'gltf'];
export const isModel = name => MODEL_EXT.includes(String(name || '').split('.').pop().toLowerCase());
const PALETTE = [0xd9d6e6, 0xc4b5fd, 0x9fe3ef, 0xfcd98a, 0xb5ecc8, 0xf9c0c0, 0xdcc6fb, 0xa9d8f7];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function loadPart(file, color, clip) {
  const ext = String(file.name).split('.').pop().toLowerCase();
  const res = await fetch(file.url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`${file.name} could not be loaded.`);
  const buf = await res.arrayBuffer();
  const mat = () => new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.04, side: THREE.DoubleSide, clippingPlanes: clip });
  let obj;
  if (ext === 'stl') { const g = new STLLoader().parse(buf); g.computeVertexNormals(); obj = new THREE.Mesh(g, mat()); }
  else if (ext === 'obj') { obj = new OBJLoader().parse(new TextDecoder().decode(buf)); obj.traverse(c => { if (c.isMesh) c.material = mat(); }); }
  else if (ext === '3mf') {
    obj = new ThreeMFLoader().parse(buf);
    obj.traverse(c => { if (!c.isMesh) return; const keep = c.material && c.material.color && c.material.color.getHex() !== 0xffffff;
      c.material = keep ? new THREE.MeshStandardMaterial({ color: c.material.color, roughness: 0.62, side: THREE.DoubleSide, clippingPlanes: clip }) : mat(); });
  } else {
    const l = new GLTFLoader(); l.setMeshoptDecoder(MeshoptDecoder);
    obj = await new Promise((ok, no) => l.parse(buf, '', g => ok(g.scene), no));
    obj.traverse(c => { if (c.isMesh) { c.material = c.material.clone(); c.material.side = THREE.DoubleSide; c.material.clippingPlanes = clip; } });
  }
  obj.userData.part = file.name;
  obj.traverse(c => { c.userData.part = file.name; });
  return obj;
}

export function mount(el, opts = {}) {
  const files = (opts.files || (opts.url ? [{ url: opts.url, name: opts.name }] : [])).filter(f => isModel(f.name));
  const comment = !!(opts.comment || opts.editable);
  el.classList.add('v3d');
  el.innerHTML = `<div class="v3d-stage"><canvas></canvas><div class="v3d-pins"></div><div class="v3d-msg">Loading 3D model</div></div>
    <div class="v3d-tools">
      <div class="v3d-parts" hidden></div>
      <label class="v3d-cut" hidden><span>Cut height</span><input type="range" min="0" max="100" value="100" aria-label="Cut through the model to see inside"><b>Full</b></label>
    </div>
    <div class="v3d-bar"><span class="v3d-hint">${comment ? 'Drag to turn, scroll or pinch to zoom. <b>Click the model to comment on that spot.</b>' : 'Drag to turn, scroll or pinch to zoom.'}</span><button type="button" class="v3d-reset">Reset view</button></div>`;
  const stage = el.querySelector('.v3d-stage'), canvas = el.querySelector('canvas'), layer = el.querySelector('.v3d-pins'), msg = el.querySelector('.v3d-msg');
  const partsEl = el.querySelector('.v3d-parts'), cutEl = el.querySelector('.v3d-cut'), cutIn = cutEl.querySelector('input'), cutLabel = cutEl.querySelector('b');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1)); renderer.localClippingEnabled = true;
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(38, 1, 0.01, 5000);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a87a8, 1.15));
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(3, 5, 4); scene.add(key);
  const rim = new THREE.DirectionalLight(0xc4b5fd, 0.6); rim.position.set(-4, 2, -3); scene.add(rim);
  const controls = new OrbitControls(camera, canvas); controls.enableDamping = true;
  const root = new THREE.Group(), model = new THREE.Group(); root.add(model); scene.add(root);
  const cut = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e9), clip = [cut];
  let alive = true, loaded = false, home = null, yMin = 0, yMax = 1, pins = [], temp = null;
  const parts = new Map(); // name -> object

  const size = () => { const w = stage.clientWidth, h = stage.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix(); };
  const ro = new ResizeObserver(size); ro.observe(stage); size();

  const norm = list => (list || []).map(p => ({ n: p.n, pos: p.pos || p.p, part: p.part || null, status: p.status || 'open', note: p.body || p.note || '' }));
  function drawPins() {
    layer.innerHTML = pins.map(p => `<button type="button" class="v3d-pin ${p.status === 'resolved' ? 'res' : ''}" data-n="${p.n}" title="${esc(p.note || 'Comment ' + p.n)}">${p.n}</button>`).join('')
      + (temp ? '<span class="v3d-pin tmp" data-tmp="1">+</span>' : '');
  }
  const v = new THREE.Vector3();
  function placeOne(b, pos, part) {
    v.set(pos[0], pos[1], pos[2]); model.localToWorld(v);
    const partHidden = part && parts.has(part) && !parts.get(part).visible;
    const cutAway = cutIn.value !== '100' && v.y > cut.constant + 1e-6;
    v.project(camera);
    b.style.transform = `translate(${(v.x + 1) / 2 * stage.clientWidth}px, ${(1 - v.y) / 2 * stage.clientHeight}px) translate(-50%, -100%)`;
    b.style.opacity = v.z > 1 || partHidden || cutAway ? 0 : 1; b.style.pointerEvents = v.z > 1 || partHidden || cutAway ? 'none' : 'auto';
  }
  function placePins() {
    if (!loaded) return;
    layer.querySelectorAll('[data-n]').forEach(b => { const p = pins.find(x => x.n === +b.dataset.n); if (p && p.pos) placeOne(b, p.pos, p.part); });
    const t = layer.querySelector('[data-tmp]'); if (t && temp) placeOne(t, temp.pos, temp.part);
  }
  const api = {
    setPins(list) { pins = norm(list); drawPins(); },
    focusPin(n) {
      const p = pins.find(x => x.n === n); if (!p || !loaded) return;
      if (p.part && parts.has(p.part) && !parts.get(p.part).visible) { parts.get(p.part).visible = true; syncParts(); }
      const w = new THREE.Vector3(...p.pos); model.localToWorld(w);
      const dir = camera.position.clone().sub(controls.target).normalize(), dist = Math.max(camera.position.distanceTo(controls.target) * 0.6, 1e-3);
      controls.target.copy(w); camera.position.copy(w.clone().add(dir.multiplyScalar(dist))); controls.update();
      const b = layer.querySelector(`[data-n="${n}"]`); if (b) { b.classList.add('on'); setTimeout(() => b.classList.remove('on'), 1600); }
    },
    showTemp(pick) { temp = pick; drawPins(); },
    clearTemp() { temp = null; drawPins(); },
    destroy() { if (!alive) return; alive = false; ro.disconnect(); controls.dispose(); renderer.dispose(); },
  };
  const loop = () => { if (!alive) return; if (!canvas.isConnected) { api.destroy(); return; } controls.update(); renderer.render(scene, camera); placePins(); requestAnimationFrame(loop); };

  function syncParts() { partsEl.querySelectorAll('input[data-part]').forEach(i => { i.checked = parts.get(i.dataset.part).visible; }); }
  function setCut(pct) {
    const h = yMin + (yMax - yMin) * pct / 100;
    cut.constant = pct >= 100 ? 1e9 : h;
    cutLabel.textContent = pct >= 100 ? 'Full' : `${pct}%`;
  }

  if (!files.length) { msg.textContent = 'No 3D file in this round. Download the files instead.'; }
  Promise.all(files.map((f, i) => loadPart(f, PALETTE[i % PALETTE.length], clip))).then(objs => {
    if (!alive) return;
    objs.forEach(o => { model.add(o); parts.set(o.userData.part, o); });
    // print files are Z up: stand them upright
    if (files.some(f => /\.(stl|3mf)$/i.test(f.name))) root.rotation.x = -Math.PI / 2;
    const box = new THREE.Box3().setFromObject(model), c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    model.position.sub(c);
    root.updateMatrixWorld(true);
    const wbox = new THREE.Box3().setFromObject(model); yMin = wbox.min.y; yMax = wbox.max.y;
    const r = Math.max(s.x, s.y, s.z) || 1, d = r * 1.9;
    camera.position.set(d * 0.8, d * 0.55, d); camera.near = r / 200; camera.far = r * 100; camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0); controls.update(); home = camera.position.clone();
    if (objs.length > 1) {
      partsEl.hidden = false;
      partsEl.innerHTML = '<span class="v3d-label">Parts</span>' + objs.map((o, i) => `<label class="v3d-part"><input type="checkbox" checked data-part="${esc(o.userData.part)}"><i style="background:#${PALETTE[i % PALETTE.length].toString(16).padStart(6, '0')}"></i>${esc(o.userData.part.replace(/\.[^.]+$/, ''))}</label>`).join('')
        + '<button type="button" class="v3d-all">Show all</button>';
      partsEl.addEventListener('change', e => { const i = e.target.closest('input[data-part]'); if (i) parts.get(i.dataset.part).visible = i.checked; });
      partsEl.querySelector('.v3d-all').addEventListener('click', () => { parts.forEach(p => { p.visible = true; }); syncParts(); });
    }
    cutEl.hidden = false; cutIn.addEventListener('input', () => setCut(+cutIn.value));
    loaded = true; msg.hidden = true; pins = norm(opts.pins); drawPins(); loop();
  }).catch(e => { msg.textContent = (e && e.message) || 'The model could not be shown. Download it instead.'; });

  el.querySelector('.v3d-reset').addEventListener('click', () => { if (home) { camera.position.copy(home); controls.target.set(0, 0, 0); controls.update(); cutIn.value = 100; setCut(100); parts.forEach(p => { p.visible = true; }); syncParts(); } });

  // a click (not a drag) on a visible part picks a spot
  let down = null;
  canvas.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', e => {
    if (!comment || !loaded || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const rect = canvas.getBoundingClientRect(), ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1), camera);
    const hits = ray.intersectObject(model, true).filter(h => { let o = h.object; while (o) { if (!o.visible) return false; o = o.parent; } return cut.distanceToPoint(h.point) >= -1e-6; });
    const hit = hits[0]; if (!hit) return;
    const local = model.worldToLocal(hit.point.clone());
    const pick = { pos: [local.x, local.y, local.z].map(n => Math.round(n * 1000) / 1000), part: hit.object.userData.part || null };
    if (opts.onPick) { temp = pick; drawPins(); opts.onPick(pick); }
    else if (opts.onChange) { pins.push({ n: pins.length + 1, pos: pick.pos, part: pick.part, status: 'open', note: '' }); drawPins(); opts.onChange(pins.map(p => ({ n: p.n, p: p.pos, part: p.part, note: p.note }))); }
  });
  layer.addEventListener('click', e => { const b = e.target.closest('[data-n]'); if (b) { if (opts.onPinClick) opts.onPinClick(+b.dataset.n); el.dispatchEvent(new CustomEvent('pin', { detail: +b.dataset.n })); } });
  return api;
}
