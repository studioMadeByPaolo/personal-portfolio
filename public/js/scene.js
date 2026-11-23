// Scroll-driven 3D scene: one sticky WebGL stage, devices change pose per `.step` section.
(function () {
  const stage = document.getElementById('stage');
  const canvas = document.getElementById('scene');
  const steps = Array.from(document.querySelectorAll('.step[data-step]'));
  const dots = Array.from(document.querySelectorAll('.dot[data-i]'));
  if (!stage || !canvas || !steps.length) return;

  let step = 0;
  const setStep = (i) => {
    step = i;
    dots.forEach((d) => d.classList.toggle('on', Number(d.dataset.i) === i));
  };

  // Active section = the last `.step` whose top passed the reading line (lower on phones, where the stage covers the top half).
  const pick = () => {
    const line = innerHeight * (innerWidth < 820 ? 0.75 : 0.5);
    let best = 0;
    steps.forEach((el, i) => { if (el.getBoundingClientRect().top < line) best = i; });
    if (best !== step) setStep(best);
  };
  window.addEventListener('scroll', pick, { passive: true });
  window.addEventListener('resize', pick);
  pick();

  const T = window.THREE;
  let renderer;
  try {
    if (!T) throw new Error('three.js missing');
    renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (e) {
    document.body.classList.add('no-gl');
    return;
  }

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputEncoding = T.sRGBEncoding;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFSoftShadowMap;

  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 0.25, 10);
  const rig = new T.Group();
  scene.add(rig);

  // Warm studio: emissive panels baked into an env map for the lacquer reflections.
  const env = new T.Scene();
  env.add(new T.Mesh(new T.BoxGeometry(30, 30, 30), new T.MeshBasicMaterial({ color: 0x140e0b, side: T.BackSide })));
  const panel = (w, h, hex, k, x, y, z) => {
    const m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ color: new T.Color(hex).multiplyScalar(k), side: T.DoubleSide }));
    m.position.set(x, y, z); m.lookAt(0, 0, 0); env.add(m);
  };
  panel(10, 5, 0xfff0e0, 5, 0, 9, 4);
  panel(3, 12, 0xffd9b8, 3, -9, 1, 3);
  panel(4, 12, 0xe07a45, 2.2, 9, 0, -1);
  panel(12, 2, 0xffffff, 1.4, 0, -2, 10);
  const pmrem = new T.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(env, 0.035).texture;
  pmrem.dispose();

  scene.add(new T.AmbientLight(0xfff1e6, 0.25));
  const key = new T.DirectionalLight(0xffe2c4, 2.4);
  key.position.set(3.5, 6, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.radius = 6;
  key.shadow.bias = -0.0005;
  Object.assign(key.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 1, far: 24 });
  key.shadow.camera.updateProjectionMatrix();
  scene.add(key);
  const rim = new T.DirectionalLight(0xe07a45, 1.2);
  rim.position.set(-5, 2, -4);
  scene.add(rim);
  const ground = new T.Mesh(new T.PlaneGeometry(40, 40), new T.ShadowMaterial({ opacity: 0.32 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.9;
  ground.receiveShadow = true;
  scene.add(ground);

  // Geometry helpers
  const shape = (w, h, r) => {
    const s = new T.Shape(), x = -w / 2, y = -h / 2;
    s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
    s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
    return s;
  };
  const slab = (w, h, r, d, b) => {
    const g = new T.ExtrudeGeometry(shape(w, h, r), { depth: d, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 5, curveSegments: 20 });
    g.center();
    return g;
  };
  const flat = (w, h, r) => {
    const g = new T.ShapeGeometry(shape(w, h, r), 20);
    const p = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / w + 0.5, p.getY(i) / h + 0.5);
    uv.needsUpdate = true;
    return g;
  };

  // Screens: two-texture crossfade, raw passthrough (screenshots are already display-ready sRGB).
  const VS = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
  const FS = 'uniform sampler2D a; uniform sampler2D b; uniform float m; uniform float glow; varying vec2 vUv; void main(){ vec3 c = mix(texture2D(a, vUv).rgb, texture2D(b, vUv).rgb, m); gl_FragColor = vec4(c * glow, 1.0); }';
  const screenMat = (t) => new T.ShaderMaterial({ uniforms: { a: { value: t }, b: { value: t }, m: { value: 0 }, glow: { value: 0.04 } }, vertexShader: VS, fragmentShader: FS });

  const blank = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 4;
    const x = c.getContext('2d'); x.fillStyle = '#1b1410'; x.fillRect(0, 0, 4, 4);
    return new T.CanvasTexture(c);
  })();
  const loader = new T.TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const tex = (name) => {
    const holder = { t: blank };
    loader.load('/images/' + name, (t) => { t.anisotropy = maxAniso; holder.t = t; });
    return holder;
  };

  const lacquer = new T.MeshPhysicalMaterial({ color: new T.Color('#E07A45').convertSRGBToLinear(), metalness: 0.15, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08 });
  const sand = new T.MeshPhysicalMaterial({ color: new T.Color('#E4D6C3').convertSRGBToLinear(), metalness: 0.1, roughness: 0.38, clearcoat: 1, clearcoatRoughness: 0.12 });
  const glass = new T.MeshPhysicalMaterial({ color: 0x050403, roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.03 });
  const cream = new T.MeshPhysicalMaterial({ color: new T.Color('#EFE6DA').convertSRGBToLinear(), roughness: 0.42, clearcoat: 0.6, clearcoatRoughness: 0.2 });
  const graphite = new T.MeshPhysicalMaterial({ color: new T.Color('#2A2421').convertSRGBToLinear(), metalness: 0.6, roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.15 });
  const ink = new T.MeshBasicMaterial({ color: 0x050403 });

  const device = (shellMat, W, H, R, D, B, holders, sw, sh, sr, sy, phase) => {
    const outer = new T.Group(), inner = new T.Group();
    outer.add(inner);
    const shell = new T.Mesh(slab(W, H, R, D, B), shellMat);
    shell.castShadow = true;
    inner.add(shell);
    const front = D / 2 + B;
    const screen = new T.Mesh(flat(sw, sh, sr), screenMat(holders[0].t));
    screen.position.set(0, sy, front + 0.003);
    inner.add(screen);
    outer.userData = { inner, screen, front, holders, shown: 0, want: 0, fadeTo: 0, fading: false, mix: 0, on: false, spin: 0, spinTarget: 0, phase };
    rig.add(outer);
    return outer;
  };

  const phone = (holders, phase, android) => {
    const o = device(android ? sand : lacquer, 1.0, 2.1, android ? 0.12 : 0.17, 0.08, 0.035, holders, 0.93, 2.03, android ? 0.08 : 0.13, 0, phase);
    const u = o.userData;
    const bezel = new T.Mesh(flat(0.995, 2.095, 0.165), glass);
    bezel.position.z = u.front + 0.001;
    u.inner.add(bezel);
    // iPhone: island + square camera. Android: punch-hole + camera bar.
    const island = new T.Mesh(android ? new T.CircleGeometry(0.032, 24) : flat(0.27, 0.075, 0.0375), ink);
    island.position.set(0, android ? 0.95 : 0.93, u.front + 0.005);
    u.inner.add(island);
    const cam = new T.Mesh(android ? slab(0.8, 0.2, 0.09, 0.02, 0.012) : slab(0.34, 0.34, 0.09, 0.02, 0.012), graphite);
    cam.position.set(android ? 0 : -0.27, android ? 0.8 : 0.77, -u.front - 0.012);
    u.inner.add(cam);
    (android ? [[-0.24, 0.8], [-0.06, 0.8]] : [[-0.34, 0.84], [-0.2, 0.7]]).forEach((p) => {
      const lens = new T.Mesh(new T.CylinderGeometry(0.052, 0.052, 0.025, 32), glass);
      lens.rotation.x = Math.PI / 2;
      lens.position.set(p[0], p[1], -u.front - 0.035);
      u.inner.add(lens);
    });
    return o;
  };

  const phoneA = phone([
    tex('nikecountryretreat_mobile_1.webp'), tex('matteoverdi_mobile_1.webp'), tex('matteoverdi_mobile_2.webp'),
    tex('robe2000_mobile.jpg'), tex('lodgeos_floor_mobile.webp'), tex('lodgeos_widget_mobile.webp'),
  ], 0, false);
  const phoneB = phone([tex('nikecountryretreat_mobile_2.webp')], 1.7, true);

  const browser = device(cream, 3.2, 2.18, 0.1, 0.04, 0.02, [
    tex('robe2000_website_1.webp'), tex('robe2000_website_2.webp'), tex('matteoverdi_website.webp'), tex('nikecountryretreat_website_v2.webp'),
  ], 3.1, 1.945, 0.05, -0.0675, 0.9);
  ['#E07A45', '#D9B48A', '#8C9A6B'].forEach((c, i) => {
    const dot = new T.Mesh(new T.CircleGeometry(0.034, 24), new T.MeshBasicMaterial({ color: new T.Color(c).convertSRGBToLinear() }));
    dot.position.set(-1.46 + i * 0.11, 0.995, browser.userData.front + 0.002);
    browser.userData.inner.add(dot);
  });
  const pill = new T.Mesh(flat(1.1, 0.075, 0.0375), new T.MeshBasicMaterial({ color: new T.Color('#E2D7C8').convertSRGBToLinear() }));
  pill.position.set(0, 0.995, browser.userData.front + 0.002);
  browser.userData.inner.add(pill);

  const tablet = device(graphite, 2.9, 1.86, 0.14, 0.05, 0.025, [
    tex('lodgeos_service.webp'), tex('lodgeos_calendar.webp'), tex('lodgeos_dashboard.webp'),
  ], 2.74, 1.7125, 0.06, 0, 2.4);
  const tb = new T.Mesh(flat(2.86, 1.82, 0.13), glass);
  tb.position.z = tablet.userData.front + 0.001;
  tablet.userData.inner.add(tb);

  // Per-section poses: [x, y, z, rotX, rotY, rotZ, scale]. Hidden = scale ~0.
  // 0 hero, 1 Nike, 2 RO.BE, 3 Matteo, 4 LodgeOS, 5 Processo — always to the right of the copy.
  const H0 = 0.0001;
  const P = {
    phoneA: [[1.75, 0.05, 0.6, -0.1, -2.55, 0.16, 1], [2.55, -0.2, 0.9, 0.02, -0.35, 0.02, 0.95], [2.95, -0.6, 1.1, 0.02, -0.45, 0.03, 0.72], [2.95, -0.55, 1.1, 0.02, -0.45, 0.03, 0.72], [2.95, -0.6, 1.1, 0.02, -0.45, 0.03, 0.72], [3.05, -0.5, 1.3, 0.05, -0.7, 0.1, 0.62]],
    phoneB: [[1.75, 0, 0, 0, -2.5, 0, H0], [1.25, -0.05, 0.5, 0.02, -0.2, -0.03, 0.95], [1.2, -0.05, -1.5, 0, -0.2, 0, H0], [1.2, -0.05, -1.5, 0, -0.2, 0, H0], [1.2, -0.05, -1.5, 0, -0.2, 0, H0], [1.2, -0.05, -1.5, 0, -0.2, 0, H0]],
    browser: [[2.75, 0.75, -2.6, 0.05, -0.42, 0.02, 0.78], [2.1, 0.85, -2.4, 0.04, -0.4, 0, 0.85], [1.8, 0.15, -0.2, 0, -0.3, 0, 1.0], [2.0, 0.35, -0.9, 0.02, -0.34, 0, 0.95], [2.2, 0.8, -3.5, 0, -0.3, 0, H0], [2.05, 0.8, -1.5, 0.04, -0.35, 0.02, 0.62]],
    tablet: [[2, -3, 0, 0, 0, 0, H0], [2, -3, 0, 0, 0, 0, H0], [2, -3, 0, 0, 0, 0, H0], [2, -1.5, -1, 0, -0.3, 0, H0], [1.75, 0.1, 0.1, -0.18, -0.3, 0.02, 1], [1.05, -0.62, 0.2, -0.15, -0.25, 0.02, 0.58]],
  };
  // On phones the group is recentred in the half-height stage, per section.
  const CENTER = [1.9, 1.9, 2.3, 2.4, 2.3, 2.2];
  const objs = [[phoneA, 'phoneA'], [phoneB, 'phoneB'], [browser, 'browser'], [tablet, 'tablet']];
  const outers = objs.map((o) => o[0]);
  objs.forEach(([o, k]) => {
    const p = P[k][0];
    o.position.set(p[0], p[1], p[2]);
    o.rotation.set(p[3], p[4], p[5]);
    o.scale.setScalar(p[6]);
  });

  let mob = false;
  const size = () => {
    const r = stage.getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    mob = w < 820 || w / h < 0.9;
    rig.position.z = mob ? 2 : 0;
  };
  size();
  new ResizeObserver(size).observe(stage);

  let paused = false;
  new IntersectionObserver((e) => { paused = !e[0].isIntersecting; }).observe(stage);

  // Pointer: parallax, drag to rotate, tap to spin.
  const TAU = Math.PI * 2;
  const ray = new T.Raycaster(), ndc = new T.Vector2();
  const owner = (o) => { while (o && !(o.userData && o.userData.inner)) o = o.parent; return o; };
  let down = null, px = 0, py = 0;
  canvas.addEventListener('pointerdown', (e) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(outers, true).find((h) => { const o = owner(h.object); return o && o.visible; });
    if (hit) { down = { o: owner(hit.object), x: e.clientX, moved: false }; canvas.style.cursor = 'grabbing'; }
  });
  window.addEventListener('pointermove', (e) => {
    px = (e.clientX / (window.innerWidth || 1)) * 2 - 1;
    py = (e.clientY / (window.innerHeight || 1)) * 2 - 1;
    if (down) {
      const dx = e.clientX - down.x;
      down.x = e.clientX;
      if (Math.abs(dx) > 1) down.moved = true;
      down.o.userData.spinTarget += dx * 0.012;
    }
  }, { passive: true });
  window.addEventListener('pointerup', () => {
    if (down && !down.moved) down.o.userData.spinTarget += TAU;
    down = null; canvas.style.cursor = '';
  });
  window.addEventListener('pointercancel', () => { down = null; canvas.style.cursor = ''; });
  // Scrolling hands rotation back to the choreography: manual spins settle on the nearest full turn.
  window.addEventListener('scroll', () => {
    outers.forEach((o) => {
      if (down && down.o === o) return;
      const u = o.userData;
      u.spinTarget = Math.round(u.spin / TAU) * TAU;
    });
  }, { passive: true });

  const screenTick = (o, dt) => {
    const u = o.userData, un = u.screen.material.uniforms;
    if (u.fading) {
      u.mix = Math.min(1, u.mix + dt * 2.5);
      if (u.mix >= 1) { u.shown = u.fadeTo; u.fading = false; u.mix = 0; }
    } else if (u.want !== u.shown) { u.fading = true; u.fadeTo = u.want; u.mix = 0; }
    un.a.value = u.holders[u.shown].t;
    un.b.value = u.holders[u.fading ? u.fadeTo : u.shown].t;
    un.m.value = u.mix;
    un.glow.value += ((u.on ? 1 : 0.04) - un.glow.value) * (reduce ? 1 : Math.min(1, dt * 3));
  };

  const clock = new T.Clock();
  const vT = new T.Vector3(), eT = new T.Euler(), qT = new T.Quaternion();
  const idle = reduce ? 0 : 1;
  const loop = () => {
    requestAnimationFrame(loop);
    if (paused) return;
    const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
    const k = reduce ? 1 : 1 - Math.exp(-dt * 3.2);
    const tick = Math.floor(t / 4) % 2;

    phoneA.userData.on = step >= 1;
    phoneA.userData.want = [0, 0, 3, 1 + tick, 4 + tick, 4][step];
    phoneB.userData.on = step === 1;
    browser.userData.on = true;
    browser.userData.want = [0, 3, tick, 2, 0, 2][step];
    tablet.userData.on = step >= 4;
    tablet.userData.want = step === 4 ? Math.floor(t / 4) % 3 : 0;

    objs.forEach(([o, key]) => {
      const p = P[key][step], u = o.userData;
      vT.set(p[0], p[1], p[2]); o.position.lerp(vT, k);
      eT.set(p[3], p[4], p[5]); qT.setFromEuler(eT); o.quaternion.slerp(qT, k);
      const s = o.scale.x + (p[6] - o.scale.x) * k;
      o.scale.setScalar(Math.max(s, H0));
      o.visible = s > 0.01;
      u.spin += (u.spinTarget - u.spin) * Math.min(1, dt * 3.5);
      const sway = step === 0 ? Math.sin(t * 0.5 + u.phase) * 0.35 : 0;
      u.inner.rotation.y = u.spin + sway * idle;
      u.inner.position.y = Math.sin(t * 1.2 + u.phase) * 0.045 * idle;
      u.inner.rotation.x = Math.sin(t * 0.8 + u.phase) * 0.025 * idle;
      screenTick(o, dt);
    });
    const pk = Math.min(1, dt * 2.5);
    rig.position.x += ((mob ? -CENTER[step] : 0) - rig.position.x) * k;
    rig.position.y += ((mob ? -0.15 : 0) - rig.position.y) * k;
    rig.rotation.y += (px * 0.1 * idle - rig.rotation.y) * pk;
    rig.rotation.x += (py * 0.05 * idle - rig.rotation.x) * pk;
    renderer.render(scene, camera);
  };
  loop();
})();
