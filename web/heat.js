/*
 * The heat behind the page.
 *
 * Warm motes rising slowly, as air does off hot ground, a low sun glow that leans toward the pointer, and a faint
 * shimmer along the bottom. Move the pointer through the motes and they drift aside. It is decoration, so it is
 * never in the way: behind everything, ignored by assistive technology, still for anyone who asked for reduced
 * motion, and paused when the tab is not showing.
 */
const canvas = document.createElement('canvas');
canvas.className = 'sky';
canvas.setAttribute('aria-hidden', 'true');
document.body.prepend(canvas);
const ctx = canvas.getContext('2d');

const still = window.matchMedia('(prefers-reduced-motion: reduce)');
const prefersLight = window.matchMedia('(prefers-color-scheme: light)');
const isLight = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'light' : prefersLight.matches;
};

let w = 0, h = 0, dpr = 1;
let motes = [];
const pointer = { x: -9999, y: -9999, sx: 0.8, sy: 0.15 };

function seed() {
  dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  w = window.innerWidth;
  h = window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const n = Math.round(Math.min(140, (w * h) / 11000));
  motes = Array.from({ length: n }, () => fresh(true));
}

function fresh(anywhere = false) {
  return {
    x: Math.random() * w,
    y: anywhere ? Math.random() * h : h + 10,
    r: Math.random() * 1.8 + 0.6,
    rise: 0.15 + Math.random() * 0.45,
    sway: Math.random() * Math.PI * 2,
    warm: Math.random(),
    vx: 0,
  };
}

function frame(time) {
  const light = isLight();
  ctx.clearRect(0, 0, w, h);

  // The sun glow, eased toward the pointer, kept high on the page.
  const tx = pointer.x > -1 ? pointer.x / Math.max(1, w) : 0.8;
  pointer.sx += (tx - pointer.sx) * 0.03;
  const gx = w * (0.55 + pointer.sx * 0.4);
  const gy = h * 0.08;
  const glow = ctx.createRadialGradient(gx, gy, 0, gx, gy, Math.max(w, h) * 0.6);
  glow.addColorStop(0, light ? 'rgba(255,170,120,0.22)' : 'rgba(255,110,70,0.16)');
  glow.addColorStop(0.45, light ? 'rgba(255,200,160,0.08)' : 'rgba(255,90,54,0.05)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  // A shimmer near the bottom, the way air bends over a hot road.
  ctx.lineWidth = 1;
  for (let k = 0; k < 3; k++) {
    const base = h * (0.84 + k * 0.05);
    ctx.beginPath();
    for (let x = 0; x <= w; x += 16) {
      const y = base + Math.sin(x / 70 + time * 0.0012 * (k + 1) + k) * 3 + Math.sin(x / 23 - time * 0.002) * 1.2;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = light ? `rgba(194,56,26,${0.05 - k * 0.012})` : `rgba(255,122,92,${0.07 - k * 0.018})`;
    ctx.stroke();
  }

  for (const m of motes) {
    if (!still.matches) {
      m.y -= m.rise;
      m.sway += 0.01;
      // Drift aside from the pointer, then settle back.
      const dx = m.x - pointer.x, dy = m.y - pointer.y;
      const d = Math.hypot(dx, dy);
      if (d < 120 && d > 0.1) m.vx += (dx / d) * (1 - d / 120) * 0.6;
      m.vx *= 0.92;
      m.x += m.vx + Math.sin(m.sway) * 0.25;
      if (m.y < -10 || m.x < -20 || m.x > w + 20) Object.assign(m, fresh());
    }
    // Brighter low down, fading as it rises, like heat leaving the ground.
    const life = Math.max(0, Math.min(1, m.y / h));
    const a = (light ? 0.28 : 0.5) * (0.25 + life * 0.75);
    const [r, g, b] = m.warm > 0.5 ? (light ? [194, 56, 26] : [255, 122, 92]) : (light ? [184, 92, 21] : [255, 170, 90]);
    ctx.beginPath();
    ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
    ctx.fill();
  }
}

let raf = 0;
function loop(time) {
  frame(time);
  raf = still.matches || document.hidden ? 0 : requestAnimationFrame(loop);
}
function start() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  if (still.matches) frame(performance.now());
  else raf = requestAnimationFrame(loop);
}

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { seed(); start(); }, 150);
});
window.addEventListener('pointermove', (e) => { pointer.x = e.clientX; pointer.y = e.clientY; }, { passive: true });
window.addEventListener('pointerleave', () => { pointer.x = pointer.y = -9999; });
document.addEventListener('visibilitychange', () => { if (!document.hidden) start(); });
still.addEventListener?.('change', start);
prefersLight.addEventListener?.('change', start);
new MutationObserver(() => { if (still.matches) frame(performance.now()); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

seed();
start();
