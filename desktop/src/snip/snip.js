// Full-screen "drag a box" picker over a frozen screenshot. Reports the box in CSS px.
(function () {
  const c = document.getElementById('c');
  const ctx = c.getContext('2d');
  const img = new Image();
  let start = null, box = null;

  function fit() {
    c.width = Math.round(innerWidth * devicePixelRatio);
    c.height = Math.round(innerHeight * devicePixelRatio);
    draw();
  }
  function draw() {
    const d = devicePixelRatio;
    ctx.clearRect(0, 0, c.width, c.height);
    if (img.complete && img.naturalWidth) ctx.drawImage(img, 0, 0, c.width, c.height);
    ctx.fillStyle = 'rgba(10, 8, 20, .55)';
    ctx.fillRect(0, 0, c.width, c.height);
    if (!box) return;
    const x = box.x * d, y = box.y * d, w = box.w * d, h = box.h * d;
    if (img.complete) ctx.drawImage(img, x / c.width * img.naturalWidth, y / c.height * img.naturalHeight, w / c.width * img.naturalWidth, h / c.height * img.naturalHeight, x, y, w, h);
    ctx.strokeStyle = '#e3263b'; ctx.lineWidth = 3 * d; ctx.setLineDash([8 * d, 6 * d]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    ctx.font = `600 ${13 * d}px Segoe UI, sans-serif`;
    const label = `${Math.round(box.w)} × ${Math.round(box.h)}`;
    ctx.fillStyle = '#121427'; ctx.fillRect(x, Math.max(0, y - 22 * d), ctx.measureText(label).width + 12 * d, 20 * d);
    ctx.fillStyle = '#5ff2ff'; ctx.fillText(label, x + 6 * d, Math.max(14 * d, y - 7 * d));
  }

  window.snip.onImage((url) => { img.onload = draw; img.src = url; });
  addEventListener('resize', fit);
  addEventListener('mousedown', (e) => { if (e.button === 2) return window.snip.cancel(); start = { x: e.clientX, y: e.clientY }; box = null; });
  addEventListener('mousemove', (e) => {
    if (!start) return;
    box = { x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY), w: Math.abs(e.clientX - start.x), h: Math.abs(e.clientY - start.y) };
    draw();
  });
  addEventListener('mouseup', () => {
    if (!start) return;
    start = null;
    if (!box || box.w < 8 || box.h < 8) { box = null; draw(); return; }   // a click, not a drag
    window.snip.done(box);
  });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') window.snip.cancel(); });
  addEventListener('contextmenu', (e) => e.preventDefault());
  fit();
})();
