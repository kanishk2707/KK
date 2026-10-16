// Spidey's wardrobe: hand-drawn pixel parts plus a builder that turns an outfit
// description (from the model, or saved) into layers Spidey can wear:
//   suit recolor (main + second colour), a hat, an item in his right hand, a chest emblem.
// Part rows use letters: A = main colour, C = second colour, D = detail colour,
// '.' = transparent; other letters are fixed colours from Spidey's palette (W, K, Y...).
// Shared by the renderer (wearing) and the main process (validating), so no DOM/Node APIs.
(function (root) {
  const OUTLINE = '#160f1d';
  const FIXED = { W: '#f8faff', K: '#160f1d', Y: '#ffd84a', P: '#ff4f8b', S: '#e9eef8', G: '#5ff2ff', R: '#e3263b', B: '#2b5fd6' };

  // top: frame row of the part's first row (the head's top edge is at row 2).
  const HATS = {
    cap:        { top: -1, rows: ['.....AAAAA.....', '...AAAAAAAAA...', '..AAAAADAAAAA..', '..AAAAAAAAAAA..', '.CCCCCCCCCCCCC.'] },
    crown:      { top: -1, rows: ['A....A....A', 'AA..AAA..AA', 'AAAAADAAAAA', 'AAAAAAAAAAA', 'CDCDCDCDCDC'] },
    wizard:     { top: -4, rows: ['......A......', '.....AAA.....', '.....AAD.....', '....AAAAA....', '....ADAAA....', '...AAAAAAA...', '..AAAAAAAAA..', 'CCCCCCCCCCCCC'] },
    cowboy:     { top: -1, rows: ['.....AAAAAAA.....', '....AAAAAAAAA....', '....AAAAAAAAA....', '....CCCCCCCCC....', 'AAAAAAAAAAAAAAAAA'] },
    beanie:     { top: -1, rows: ['......D......', '....AAAAA....', '..AAAAAAAAA..', '..ACACACACA..', '..CCCCCCCCC..'] },
    tophat:     { top: -3, rows: ['..AAAAAAA..', '..AAAAAAA..', '..AAAAAAA..', '..AAAAAAA..', '..CCCCCCC..', '..AAAAAAA..', 'AAAAAAAAAAA'] },
    chef:       { top: -2, rows: ['...AAA.AAA...', '..AAAAAAAAA..', '..AAAAAAAAA..', '...AAAAAAA...', '...AAAAAAA...', '...CCCCCCC...'] },
    graduation: { top: -1, rows: ['........A........', '....AAAAAAAAA....', 'AAAAAAAAAAAAAAAAD', '....AAAAAAAAA...D', '....CCCCCCCCC...D'] },
    helmet:     { top: 0, rows: ['....AAAAAAA....', '..AAAAAAAAAAA..', '.AAAADAAAAAAAA.', '.AAAAAAAAAAAAA.', '.A...........A.', '.C...........C.', '.C...........C.'] },
    bandana:    { top: 3, rows: ['AAAAAAAAAAAAAAA', 'ADAAADAAADAAADA', '.............AA'] },
    horns:      { top: -1, rows: ['A.............A', 'AA...........AA', '.AA.........AA.', '..A.........A..'] },
    halo:       { top: -5, rows: ['..AAAAAAAAA..', '.A.........A.', '..AAAAAAAAA..'] },
    santa:      { top: -4, rows: ['.............DD', '...........AACD', '.........AAAA..', '......AAAAAAC..', '...AAAAAAAAAC..', '.AAAAAAAAAAAAC.', 'DDDDDDDDDDDDDDD'] },
    party:      { top: -6, rows: ['...D...', '...A...', '..ACA..', '..CAC..', '.ACACA.', '.CACAC.', 'ACACACA'] },
    pirate:     { top: -2, rows: ['A.............A', 'AA....AAA....AA', 'AAAAAAAWAAAAAAA', '.AAAAAWWWAAAAA.', '..AAAAAWAAAAA..', '..CCCCCCCCCCC..'] },
    viking:     { top: -1, rows: ['W.............W', 'WW...AAAAA...WW', '.WWAAAAAAAAAWW.', '...AAAAAAAAA...', '...CDCDCDCDC...'] },
    beret:      { top: 0, rows: ['......D......', '..AAAAAAAAA..', '.AAAAAAAAAAA.', '..AAAAAAAAA..'] },
    catears:    { top: 0, rows: ['.A.........A.', 'AAA.......AAA', 'ACA.......ACA'] },
    bunnyears:  { top: -4, rows: ['.A.....A.', 'AAA...AAA', 'ACA...ACA', 'ACA...ACA', 'ACA...ACA', 'AAA...AAA'] },
    mohawk:     { top: -1, rows: ['..A..', '.AAA.', '.ACA.', 'AAAAA'] },
    tiara:      { top: 0, rows: ['...D...', '..DCD..', '.A.D.A.', 'AAAAAAA'] },
  };

  // grip: the cell held in his hand (column, row).
  const ITEMS = {
    bat:      { grip: [1, 1], rows: ['.D.', '.D.', '.D.', 'AAA', 'AAA', 'AAA', 'AAA', 'AAA', 'AAA', 'AAA', 'AAA', '.A.'] },
    sword:    { grip: [1, 8], rows: ['.W.', '.W.', '.W.', '.W.', '.W.', '.W.', '.W.', 'DDD', '.A.', '.A.'] },
    wand:     { grip: [2, 5], rows: ['..D..', '.DDD.', '..D..', '..A..', '..A..', '..A..', '..A..'] },
    guitar:   { grip: [3, 6], rows: ['...D...', '...D...', '...D...', '...D...', '..AAA..', '.AAAAA.', '.AAKAA.', 'AAAAAAA', 'AAAAAAA', '.AAAAA.'] },
    ball:     { grip: [1, 1], rows: ['.A.', 'ADA', '.A.'] },
    book:     { grip: [2, 2], rows: ['CAAAA', 'CADDA', 'CAAAA', 'CAAAA'] },
    mic:      { grip: [1, 4], rows: ['.K.', 'KDK', 'KDK', '.A.', '.A.', '.A.'] },
    umbrella: { grip: [5, 8], rows: ['...AAAAA...', '.AAAAAAAAA.', 'AAACAAACAAA', '.....D.....', '.....D.....', '.....D.....', '.....D.....', '.....D.....', '....DD.....'] },
    coffee:   { grip: [1, 2], rows: ['.W.W', 'AAA.', 'AAAA', 'AAA.', 'AAA.'] },
    flag:     { grip: [0, 6], rows: ['DAAAAAA', 'DAAAAAA', 'DCCCCCC', 'DCCCCCC', 'D......', 'D......', 'D......', 'D......'] },
    shield:   { grip: [3, 3], rows: ['AAAAAAA', 'ACCCCCA', 'ACDDDCA', 'ACDDDCA', 'ACCCCCA', '.ACCCA.', '..AAA..'] },
    hammer:   { grip: [2, 5], rows: ['AAAAA', 'AAAAA', 'AAAAA', '..D..', '..D..', '..D..', '..D..'] },
    trident:  { grip: [2, 6], rows: ['D.D.D', 'D.D.D', 'DDDDD', '..A..', '..A..', '..A..', '..A..', '..A..', '..A..'] },
    pizza:    { grip: [2, 4], rows: ['CCCCC', 'ADAAA', '.AAD.', '.AA..', '..A..'] },
    torch:    { grip: [1, 5], rows: ['.Y.', 'YDY', '.Y.', 'AAA', '.A.', '.A.', '.A.'] },
  };

  // costume words -> parts that make it recognisable (hints for the model, and a fallback)
  const HINTS = [
    [/cricket/, { hat: 'cap', item: 'bat', emblem: 'number' }], [/football|soccer|basketball|jersey/, { item: 'ball', emblem: 'number' }],
    [/pirate/, { hat: 'pirate', item: 'sword' }], [/viking/, { hat: 'viking', item: 'hammer' }], [/thor/, { item: 'hammer' }],
    [/chef|cook|baker/, { hat: 'chef', item: 'coffee' }], [/wizard|mage|sorcer|harry|witch/, { hat: 'wizard', item: 'wand', emblem: 'star' }],
    [/king|emperor/, { hat: 'crown', item: 'sword' }], [/queen|princess/, { hat: 'tiara', item: 'wand' }],
    [/graduat|scholar|student|topper/, { hat: 'graduation', item: 'book' }], [/astronaut|space|nasa/, { hat: 'helmet', item: 'flag', emblem: 'star' }],
    [/cowboy|sheriff|western/, { hat: 'cowboy', emblem: 'star' }], [/santa|christmas|xmas/, { hat: 'santa' }], [/party|birthday/, { hat: 'party' }],
    [/ninja|samurai/, { hat: 'bandana', item: 'sword' }], [/knight|warrior|crusader/, { hat: 'helmet', item: 'sword' }],
    [/captain america/, { item: 'shield', emblem: 'star' }], [/iron ?man|iron ?spider|tony/, { emblem: 'reactor' }], [/flash/, { emblem: 'lightning' }],
    [/rock|guitar|band/, { item: 'guitar' }], [/singer|rapper|karaoke/, { item: 'mic' }], [/\bcat\b|kitty|neko/, { hat: 'catears' }],
    [/bunny|rabbit|easter/, { hat: 'bunnyears' }], [/punk/, { hat: 'mohawk', item: 'guitar' }], [/angel/, { hat: 'halo' }],
    [/devil|demon/, { hat: 'horns', item: 'trident' }], [/french|artist|painter/, { hat: 'beret' }], [/poseidon|aquaman|ocean/, { item: 'trident' }],
    [/pizza/, { item: 'pizza' }], [/explorer|indiana|olympic/, { item: 'torch' }], [/rain/, { item: 'umbrella' }], [/coffee|barista/, { item: 'coffee' }],
  ];
  function hintsFor(text) {
    const t = String(text || '').toLowerCase();
    const out = {};
    for (const [re, h] of HINTS) if (re.test(t)) for (const [k, v] of Object.entries(h)) if (!out[k]) out[k] = v;
    return out;
  }

  const EMBLEMS = {
    star:      ['..D..', '.DDD.', 'DDDDD', '.D.D.'],
    heart:     ['DD.DD', 'DDDDD', '.DDD.', '..D..'],
    lightning: ['..DD', '.DD.', 'DDDD', '.DD.', 'DD..'],
    reactor:   ['.DDD.', 'DWWWD', 'DWWWD', '.DDD.'],
    stripe:    ['DDDDDDD', 'DDDDDDD'],
  };

  // 3x5 pixel digits for jersey numbers
  const DIGITS = {
    0: ['DDD', 'D.D', 'D.D', 'D.D', 'DDD'], 1: ['.D.', 'DD.', '.D.', '.D.', 'DDD'], 2: ['DDD', '..D', 'DDD', 'D..', 'DDD'],
    3: ['DDD', '..D', 'DDD', '..D', 'DDD'], 4: ['D.D', 'D.D', 'DDD', '..D', '..D'], 5: ['DDD', 'D..', 'DDD', '..D', 'DDD'],
    6: ['DDD', 'D..', 'DDD', 'D.D', 'DDD'], 7: ['DDD', '..D', '.D.', '.D.', '.D.'], 8: ['DDD', 'D.D', 'DDD', 'D.D', 'DDD'],
    9: ['DDD', 'D.D', 'DDD', '..D', 'DDD'],
  };

  // ---------- colours ----------
  const HEX = /^#[0-9a-f]{6}$/i;
  const NAMED = {
    red: '#e3263b', darkred: '#9c1428', blue: '#2b5fd6', navy: '#1b2a6b', lightblue: '#7cc4ff', sky: '#7cc4ff', green: '#2fae4f', darkgreen: '#1d6b33',
    lime: '#9be15d', yellow: '#ffd84a', gold: '#f2b632', orange: '#ff8a1f', purple: '#7b4bd6', violet: '#7b4bd6', pink: '#ff6fae', magenta: '#d63aa8',
    white: '#f4f4f0', cream: '#f3ead2', grey: '#8d93a6', gray: '#8d93a6', silver: '#c9cfdb', black: '#1d1b26', brown: '#7a4a24', tan: '#d6b37a',
    beige: '#e3cfa6', teal: '#1fa8a0', cyan: '#5ff2ff', maroon: '#7a1f2b', saffron: '#ff9933', khaki: '#c8b77a', olive: '#6b7a2b',
  };
  function color(v, fallback) {
    if (typeof v !== 'string') return fallback;
    const s = v.trim().toLowerCase();
    if (HEX.test(s)) return s;
    if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
    return NAMED[s.replace(/[^a-z]/g, '')] || fallback;
  }
  function shade(hex, f) {   // f < 0 darkens, f > 0 lightens
    const n = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const m = n.map((c) => Math.round(f < 0 ? c * (1 + f) : c + (255 - c) * f));
    return `#${m.map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('')}`;
  }

  // ---------- grids ----------
  /** rows of letters -> grid of hex colours (null = transparent) */
  function paint(rows, colors) {
    const w = Math.max(...rows.map((r) => r.length));
    return rows.map((r) => [...r.padEnd(w, '.')].map((ch) => (ch === '.' || ch === ' ' ? null : colors[ch] || FIXED[ch] || null)));
  }
  function outlined(grid) {
    const h = grid.length, w = grid[0].length;
    const g = Array.from({ length: h + 2 }, (_, y) => Array.from({ length: w + 2 }, (_, x) => (grid[y - 1] && grid[y - 1][x - 1]) || null));
    const out = g.map((r) => r.slice());
    for (let y = 0; y < h + 2; y++) {
      for (let x = 0; x < w + 2; x++) {
        if (g[y][x]) continue;
        if ((g[y - 1] && g[y - 1][x]) || (g[y + 1] && g[y + 1][x]) || g[y][x - 1] || g[y][x + 1]) out[y][x] = OUTLINE;
      }
    }
    return out;
  }
  /** Clean model-drawn rows: only A/C/D/., at most maxW x maxH, equal length. */
  function cleanRows(rows, maxW, maxH) {
    if (!Array.isArray(rows)) return null;
    const r = rows.map((x) => String(x).replace(/[^ACD.]/g, '.').slice(0, maxW)).slice(0, maxH);
    while (r.length && !/[ACD]/.test(r[0])) r.shift();
    while (r.length && !/[ACD]/.test(r[r.length - 1])) r.pop();
    if (!r.length) return null;
    const w = Math.max(...r.map((x) => x.length));
    return r.map((x) => x.padEnd(w, '.'));
  }

  const slug = (s) => String(s || 'outfit').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'outfit';

  /** Normalise an outfit description (from the model or a saved file) into a safe spec. */
  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const suit = raw.suit || {};
    const spec = {
      name: String(raw.name || 'New outfit').slice(0, 40),
      suit: { main: color(suit.main, null), second: color(suit.second, null) },
      hat: null, item: null, emblem: null,
    };
    const cols = (c) => ({ A: color(c?.A, '#e3263b'), C: color(c?.C, '#2b5fd6'), D: color(c?.D, '#ffd84a') });
    const hatName = String(raw.hat || '').toLowerCase();
    if (HATS[hatName]) spec.hat = { template: hatName, colors: cols(raw.hatColors) };
    else if (hatName === 'custom') {
      const rows = cleanRows(raw.customHat, 17, 9);
      // a drawn hat needs a solid base to sit on the head; otherwise it's usually scribbles
      const base = rows ? rows[rows.length - 1].replace(/\./g, '').length / rows[0].length : 0;
      if (rows && base >= 0.5) spec.hat = { rows, colors: cols(raw.hatColors) };
    }
    const itemName = String(raw.item || '').toLowerCase();
    if (ITEMS[itemName]) spec.item = { template: itemName, colors: cols(raw.itemColors) };
    else if (itemName === 'custom') { const rows = cleanRows(raw.customItem, 11, 14); if (rows) spec.item = { rows, colors: cols(raw.itemColors) }; }
    const emName = String(raw.emblem || '').toLowerCase();
    if (EMBLEMS[emName]) spec.emblem = { template: emName, color: color(raw.emblemColor, '#ffd84a') };
    else if (emName === 'number') {
      const text = String(raw.emblemText || '').replace(/\D/g, '').slice(0, 2);
      if (text) spec.emblem = { template: 'number', text, color: color(raw.emblemColor, '#ffd84a') };
    }
    // make sure the iconic pieces are there (a cricket kit always gets a cap and a bat)
    const h = hintsFor(`${raw.name || ''} ${raw.description || ''}`);
    if (!spec.hat && h.hat) spec.hat = { template: h.hat, colors: cols(raw.hatColors) };
    if (!spec.item && h.item) spec.item = { template: h.item, colors: cols(raw.itemColors) };
    if (!spec.emblem && h.emblem && h.emblem !== 'number') spec.emblem = { template: h.emblem, color: color(raw.emblemColor, '#ffd84a') };
    spec.id = slug(spec.name);
    return spec;
  }

  /**
   * Turn a spec into wearable layers (all positions in Spidey's frame pixels):
   *   palette: overrides for the suit letters
   *   hat:     { grid, x, y }         (outlined; y before nodding)
   *   item:    { grid, grip:[x,y] }   (outlined; grip is in grid coords incl. outline)
   *   emblem:  { grid, x, y }         (no outline)
   */
  function build(spec) {
    if (!spec) return null;
    const out = { id: spec.id, name: spec.name, palette: {}, hat: null, item: null, emblem: null };
    if (spec.suit?.main) {
      const m = spec.suit.main;
      const lum = [1, 3, 5].map((i) => parseInt(m.slice(i, i + 2), 16)).reduce((s, c, i) => s + c * [0.299, 0.587, 0.114][i], 0) / 255;
      out.palette.R = m;
      out.palette.H = shade(m, lum < 0.2 ? 0.45 : 0.3);
      // dark suits get lighter web lines, or the lines vanish into the black
      out.palette.r = lum < 0.2 ? shade(m, 0.3) : shade(m, -0.32);
    }
    if (spec.suit?.second) { out.palette.B = spec.suit.second; out.palette.b = shade(spec.suit.second, -0.3); }
    if (spec.hat) {
      const t = HATS[spec.hat.template];
      const rows = t ? t.rows : spec.hat.rows;
      const g = outlined(paint(rows, spec.hat.colors || {}));
      const w = g[0].length;
      out.hat = { grid: g, x: 16 - Math.floor(w / 2), y: (t ? t.top : 4 - rows.length) - 1 };
    }
    if (spec.item) {
      const t = ITEMS[spec.item.template];
      const rows = t ? t.rows : spec.item.rows;
      const grip = t ? t.grip : [Math.floor(rows[0].length / 2), rows.length - 1];
      out.item = { grid: outlined(paint(rows, spec.item.colors || {})), grip: [grip[0] + 1, grip[1] + 1] };
    }
    if (spec.emblem) {
      let rows;
      if (spec.emblem.template === 'number') {
        const ds = spec.emblem.text.split('').map((d) => DIGITS[d]);
        rows = ds[0].map((_, y) => ds.map((d) => d[y]).join('.'));
      } else rows = EMBLEMS[spec.emblem.template];
      const g = paint(rows, { D: spec.emblem.color });
      out.emblem = { grid: g, x: 16 - Math.floor(g[0].length / 2), y: 19 - Math.floor(g.length / 2) };
    }
    return out;
  }

  /** Where his right hand is (frame pixels) for a given right-arm pose. */
  function handAt(armPose, ARMS) {
    const a = ARMS[armPose] || ARMS.down;
    if (a.glove) return [a.glove[0] + 0.5, a.glove[1] + 0.5];
    if (a.front) return [a.front[0] + 1.5, a.front[1] + 1.5];
    return [22.5, 21.5];
  }

  const api = { HATS, ITEMS, EMBLEMS, NAMED, normalize, build, handAt, slug, shade, color, hintsFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Outfits = api;
})(typeof window !== 'undefined' ? window : globalThis);
