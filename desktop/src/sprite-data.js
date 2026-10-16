// Spidey's body, built from parts and outlined automatically so every pose and
// expression stays crisp. Shared by the renderer (the desktop sprite) and the
// main process (tray icon), so it has no DOM or Node dependencies.
(function (root) {
  const W = 33, H = 31;

  const PALETTE = {
    K: '#160f1d', // outline / ink
    R: '#e3263b', // suit red
    r: '#9c1428', // web lines
    H: '#ff7a7a', // red highlight
    B: '#2b5fd6', // suit blue
    b: '#1b3a8c', // blue shade
    W: '#f8faff', // eye lens
    w: '#a9c2f2', // lens shade / sweat
    P: '#ff4f8b', // heart pink
    p: '#ffb3cf', // heart shine
    Y: '#ffd84a', // sparkle
    S: '#e9eef8', // web silk
    G: '#5ff2ff', // holo cyan
    g: '#1f8fb0', // holo deep
  };

  // Head interior (outline is added automatically). Center column = 6.
  const HEAD = [
    '....RRrRR....',
    '..RHRRrRRRR..',
    '.RHrrrrrrrRR.',
    '.HrRRRrRRRrR.',
    'RHRRRRrRRRRRR',
    'RRRRRRrRRRRRR',
    'rRRRRRrRRRRRr',
    'RRRRRRrRRRRRR',
    'RRRRRRrRRRRRR',
    'RrRRRRrRRRRrR',
    '.RrrrrrrrrrR.',
    '..RRRRrRRRR..',
    '....RRrRR....',
  ];

  // Left-eye shapes (5x6); the right eye is mirrored. '.' leaves the mask showing.
  const EYES = {
    normal: ['KKK..', 'KWWKK', 'KWWWK', 'KWWWK', '.KWWK', '..KK.'],
    look:   ['KKK..', 'KWWKK', 'KWWWK', 'KWwwK', '.KwwK', '..KK.'],
    blink:  ['.....', '.....', '.....', 'KKKKK', '.KKK.', '.....'],
    happy:  ['.....', '.....', '.KKK.', 'KWWWK', 'K...K', '.....'],
    wide:   ['.KKK.', 'KWWWK', 'KWWWK', 'KWWWK', 'KWWWK', '.KKK.'],
    sad:    ['.....', '...KK', '.KKWK', 'KWWWK', 'KWWK.', '.KK..'],
    focus:  ['.....', 'K....', 'KKK..', 'KWWKK', '.KWWK', '..KK.'],
    love:   ['.....', 'KK.KK', 'KPKPK', 'KPPPK', '.KPK.', '..K..'],
    sleepy: ['.....', '.....', 'KKKKK', 'KWWWK', '.KKK.', '.....'],
    cool:   ['.....', '.....', 'KKKKK', 'KKKKK', '.KKK.', '.....'],
  };

  const TORSO = [
    '.RRRRRRR.',
    'BRRKRKRRB',
    'BRRRKRRRB',
    'BRRKRKRRB',
    'BBRRRRRBB',
    'BbBBBBBbB',
  ];

  const HAND = ['.KK.', 'KRRK', 'KRRK', '.KK.']; // outlined glove for in-front poses

  // Arm poses, written for the RIGHT arm; the left arm is the mirror image.
  // Each segment: [x0, y0, x1, y1, color]; `glove` is the 2x2 hand at the end;
  // `front` gloves are stamped with their own outline (they overlap the body).
  const ARMS = {
    down:  { segs: [[22, 17, 22, 18, 'R'], [22, 19, 22, 20, 'B']], glove: [22, 21] },
    wave1: { segs: [[22, 17, 23, 15, 'R'], [23, 14, 24, 12, 'B']], glove: [24, 10] },
    wave2: { segs: [[22, 17, 23, 15, 'R'], [24, 14, 25, 12, 'B']], glove: [26, 10] },
    up:    { segs: [[22, 17, 23, 15, 'R'], [23, 14, 24, 12, 'B']], glove: [24, 10] },
    out:   { segs: [[22, 17, 24, 17, 'R'], [25, 17, 26, 16, 'B']], glove: [27, 15] },
    shrug: { segs: [[22, 17, 23, 18, 'R'], [24, 18, 25, 17, 'B']], glove: [26, 15] },
    swing: { segs: [[22, 17, 23, 16, 'R'], [24, 15, 24, 15, 'B']], glove: [25, 13] },
    chin:  { segs: [[22, 17, 23, 19, 'R'], [24, 19, 22, 17, 'B']], front: [19, 13] },
    hips:  { segs: [[22, 17, 24, 18, 'R'], [24, 19, 23, 20, 'B']], front: [21, 19] },
    clasp: { segs: [[22, 17, 22, 19, 'R']], front: [16, 18] },
    type1: { segs: [[22, 17, 22, 19, 'R']], front: [19, 18] },
    type2: { segs: [[22, 17, 22, 19, 'R']], front: [19, 19] },
  };

  const PARTICLES = {
    heart:  ['PP.PP', 'PpPPP', 'PPPPP', '.PPP.', '..P..'],
    spark:  ['..Y..', '..Y..', 'YYWYY', '..Y..', '..Y..'],
    tiny:   ['.Y.', 'YWY', '.Y.'],
    z:      ['WWWW', '..W.', '.W..', 'WWWW'],
    q:      ['.WWW.', 'W...W', '...W.', '..W..', '.....', '..W..'],
    bang:   ['W', 'W', 'W', '.', 'W'],
    sweat:  ['.w.', 'www', 'www', '.w.'],
    note:   ['..WW', '..WW', '..W.', 'WWW.', 'WWW.'],
    dot:    ['W'],
    web:    ['S.S.S', '.SSS.', 'SSSSS', '.SSS.', 'S.S.S'],
    // a little document with a folded corner, for the web-catch when you drop files on Spidey
    file:   ['WWWWw.', 'WWWWww', 'WbbbWW', 'WWWWWW', 'WbbbbW', 'WWWWWW', 'WbbWWW', 'WWWWWW'],
    splat:  ['S...S', '.S.S.', '..S..', '.S.S.', 'S...S'],
  };

  // Outfits drawn over the head (outlined automatically). x, y: top-left in frame pixels, before nodding;
  // y can be negative (they poke out above the sprite).
  const ACCESSORIES = {
    headphones: {
      x: 7, y: 0, rows: [
        '......bbbbbbb......',
        '....bbBBBBBBBbb....',
        '...bB.........Bb...',
        '..bB...........Bb..',
        '..b.............b..',
        '.bb.............bb.',
        'BBB.............BBB',
        'BbB.............BbB',
        'BbB.............BbB',
        'BbB.............BbB',
        'BBB.............BBB',
      ],
    },
    nightcap: {
      x: 9, y: -5, rows: [
        '.............WW',
        '...........bbWW',
        '.........bbbb..',
        '......bbbbbbb..',
        '...bbbbbbbbbb..',
        '.bbbbbbbbbbbbb.',
        'WWWWWWWWWWWWWWW',
      ],
    },
    santa: {
      x: 9, y: -5, rows: [
        '.............WW',
        '...........RRWW',
        '.........RRRr..',
        '......RRRRRRr..',
        '...RRRRRRRRRr..',
        '.RRRRRRRRRRRRr.',
        'WWWWWWWWWWWWWWW',
      ],
    },
    party: {
      x: 13, y: -7, rows: [
        '...Y...',
        '...P...',
        '..PYP..',
        '..YPY..',
        '.PYPYP.',
        '.YPYPY.',
        'PYPYPYP',
      ],
    },
  };

  function blank(w = W, h = H) {
    return Array.from({ length: h }, () => new Array(w).fill(null));
  }
  function put(g, x, y, c) {
    if (y >= 0 && y < g.length && x >= 0 && x < g[0].length) g[y][x] = c;
  }
  function stamp(g, rows, ox, oy, mirror = false) {
    rows.forEach((row, y) => {
      for (let i = 0; i < row.length; i++) {
        const ch = mirror ? row[row.length - 1 - i] : row[i];
        if (ch !== '.' && ch !== ' ') put(g, ox + i, oy + y, ch);
      }
    });
  }
  function limb(g, x0, y0, x1, y1, c) {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      put(g, x0, y0, c); put(g, x0 + 1, y0, c); put(g, x0, y0 + 1, c); put(g, x0 + 1, y0 + 1, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  const mx = (x) => 31 - x; // mirror for 2px-wide brush strokes around the center column

  function drawArm(g, pose, mirror) {
    const a = ARMS[pose] || ARMS.down;
    for (const [x0, y0, x1, y1, c] of a.segs) {
      if (mirror) limb(g, mx(x0), y0, mx(x1), y1, c);
      else limb(g, x0, y0, x1, y1, c);
    }
    if (a.glove) {
      const [x, y] = a.glove;
      limb(g, mirror ? mx(x) : x, y, mirror ? mx(x) : x, y, 'R');
    }
  }
  function drawFrontHand(g, pose, mirror) {
    const a = ARMS[pose] || ARMS.down;
    if (!a.front) return;
    const [x, y] = a.front;
    stamp(g, HAND, mirror ? 29 - x : x, y);
  }

  function outline(g) {
    const h = g.length, w = g[0].length;
    const out = g.map((row) => row.slice());
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (g[y][x]) continue;
        if ((y > 0 && g[y - 1][x]) || (y < h - 1 && g[y + 1][x]) ||
            (x > 0 && g[y][x - 1]) || (x < w - 1 && g[y][x + 1])) out[y][x] = 'K';
      }
    }
    return out;
  }

  /**
   * Compose one frame.
   * opts: eyes, armL, armR, legs ('stand'|'walkA'|'walkB'|'tuck'), headDy (nod)
   */
  function composeFrame(opts = {}) {
    const o = Object.assign({ eyes: 'normal', armL: 'down', armR: 'down', legs: 'stand', headDy: 0 }, opts);
    const g = blank();

    // legs + hips
    stamp(g, ['BBBBBBBBB'], 12, 22);
    if (o.legs === 'sit' || o.legs === 'sitKick') {
      // sitting on the ground: short bent legs splayed out, boots pointing forward (3 px shorter overall)
      const kick = o.legs === 'sitKick' ? 1 : 0;
      stamp(g, ['BBBB.BBBB'], 12, 23);
      stamp(g, ['RRRR...RRRR'], 10, 24 - kick);
      stamp(g, ['RRR.....RRR'], 10, 25 - kick);
      if (kick) stamp(g, ['RRR'], 18, 25);     // one foot swings
    }
    const leg = (x, lift) => {
      const top = 23, bootY = 26 - lift;
      for (let y = top; y < bootY; y++) stamp(g, ['BB'], x + 1, y), put(g, x, y, 'B');
      stamp(g, ['RRR'], x, bootY);
      stamp(g, ['RRR'], x, bootY + 1);
    };
    if (o.legs !== 'sit' && o.legs !== 'sitKick') {
      const liftL = o.legs === 'walkA' ? 1 : o.legs === 'tuck' ? 2 : 0;
      const liftR = o.legs === 'walkB' ? 1 : o.legs === 'tuck' ? 2 : 0;
      leg(13, liftL);
      leg(17, liftR);
      stamp(g, ['RRRR'], 12, 28 - liftL);
      stamp(g, ['RRRR'], 17, 28 - liftR);
    }

    // torso and arms behind the head
    stamp(g, TORSO, 12, 16);
    drawArm(g, o.armL, true);
    drawArm(g, o.armR, false);

    // head
    const hy = 2 + o.headDy;
    stamp(g, HEAD, 10, hy);
    const eye = EYES[o.eyes] || EYES.normal;
    stamp(g, eye, 11, hy + 4);
    stamp(g, eye, 17, hy + 4, true);

    const og = outline(g);

    // hands in front of the silhouette carry their own outlines
    drawFrontHand(og, o.armL, true);
    drawFrontHand(og, o.armR, false);
    return { w: W, h: H, grid: og };
  }

  /** Small particle grid with its own outline. */
  function composeParticle(name) {
    const rows = PARTICLES[name] || PARTICLES.dot;
    const g = blank(rows[0].length + 2, rows.length + 2);
    stamp(g, rows, 1, 1);
    return { w: g[0].length, h: g.length, grid: outline(g) };
  }

  /** An outfit as its own outlined grid, plus where it sits on the frame. */
  function composeAccessory(name) {
    const a = ACCESSORIES[name];
    if (!a) return null;
    const g = blank(a.rows[0].length + 2, a.rows.length + 2);
    stamp(g, a.rows, 1, 1);
    return { w: g[0].length, h: g.length, grid: outline(g), x: a.x - 1, y: a.y - 1 };
  }

  /** Just the head (for the tray / app icon). */
  function composeHead(eyes = 'normal') {
    const g = blank(15, 15);
    stamp(g, HEAD, 1, 1);
    const eye = EYES[eyes] || EYES.normal;
    stamp(g, eye, 2, 5);
    stamp(g, eye, 8, 5, true);
    return { w: 15, h: 15, grid: outline(g) };
  }

  const api = { W, H, PALETTE, EYES, ARMS, PARTICLES, ACCESSORIES, composeFrame, composeParticle, composeHead, composeAccessory };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpriteData = api;
})(typeof window !== 'undefined' ? window : globalThis);
