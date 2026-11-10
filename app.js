'use strict';
/* 證件 / 存摺 A4 排版 PWA
 * 流程：選圖 → OpenCV 偵測四邊形 → 透視校正裁切 → MaxRects 裝箱 → A4 canvas → JPG/PNG/PDF
 * 注意：不可宣告全域 `cv`（會與 opencv.js 衝突），一律使用 CV。
 */
const $ = (s, r = document) => r.querySelector(s);
const CARD_LONG = 85.6;                 // ID-1 卡片長邊 mm
const PAGE = { w: 210, h: 297 };        // A4 mm
const BOOK_LONG = 142;                  // 存摺（闔上）長邊預設 mm
const CROP_MAX = 2000;                  // 單一裁切圖長邊上限 px
const LOAD_MAX = 4096;                  // 載入原圖長邊上限 px
let CV = null;
const S = { images: [], nextId: 1, pages: [] };

/* ========== OpenCV 載入 ========== */
const CV_SOURCES = [
  './opencv.js', // 若自行放一份 opencv.js 在同資料夾，可完全離線
  'https://docs.opencv.org/4.10.0/opencv.js',
  'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js'
];
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => res();
    s.onerror = () => { s.remove(); rej(new Error('load ' + src)); };
    document.head.appendChild(s);
  });
}
function waitForCV(timeout = 90000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    let thenCalled = false;
    (function poll() {
      const c = window.cv;
      if (c && c.Mat) return res(true); // 注意：不可 resolve(c)，cv 物件帶有 then，會造成無限迴圈
      if (c && typeof c.then === 'function' && !thenCalled) {
        thenCalled = true; c.then(m => { window.cv = m; });
      } else if (c && !c.onRuntimeInitialized && typeof c.then !== 'function') {
        c.onRuntimeInitialized = () => res(true);
      }
      if (Date.now() - t0 > timeout) return rej(new Error('cv timeout'));
      setTimeout(poll, 150);
    })();
  });
}
function setCVStat(t, err) {
  const el = $('#cvstat'); el.textContent = t; el.classList.toggle('err', !!err);
}
const cvReady = (async () => {
  const t0 = Date.now();
  const iv = setInterval(() => { if (!CV) setCVStat(`引擎載入中… ${Math.round((Date.now() - t0) / 1000)}s`); }, 500);
  const errs = [];
  for (const src of CV_SOURCES) {
    try {
      setCVStat('載入引擎：' + (src.startsWith('.') ? '本機' : new URL(src).host));
      await loadScript(src); await waitForCV(45000); CV = window.cv;
      clearInterval(iv); setCVStat('引擎就緒 ✓'); return true;
    } catch (e) { console.warn('OpenCV 載入失敗：', src, e); errs.push(src + ' → ' + (e.message || e)); }
  }
  clearInterval(iv);
  setCVStat('引擎載入失敗（點我看原因）', true);
  $('#cvstat').onclick = () => alert('OpenCV 載入失敗：\n' + errs.join('\n') + '\n\n請確認 opencv.js 與 index.html 在同一資料夾，或網路可連線。');
  throw new Error('opencv unavailable');
})();
cvReady.catch(() => {});

/* ========== 工具 ========== */
const tick = () => new Promise(r => setTimeout(r, 20));
const setStatus = t => { $('#status').textContent = t || ''; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function orderPts(pts) { // 順時針，起點為左上
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length, cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const a = pts.slice().sort((p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx));
  let k = 0, best = Infinity;
  a.forEach((p, i) => { if (p.x + p.y < best) { best = p.x + p.y; k = i; } });
  return a.slice(k).concat(a.slice(0, k));
}
function polyArea(p) {
  let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a.x * b.y - b.x * a.y; }
  return Math.abs(s) / 2;
}
function inPoly(pt, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
async function fileToCanvas(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { bmp = await createImageBitmap(file); }
  const s = Math.min(1, LOAD_MAX / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  return c;
}

/* ========== 偵測 ========== */
function detectQuads(canvas) {
  const maxd = 900, s = Math.min(1, maxd / Math.max(canvas.width, canvas.height));
  const sm = document.createElement('canvas');
  sm.width = Math.round(canvas.width * s); sm.height = Math.round(canvas.height * s);
  sm.getContext('2d').drawImage(canvas, 0, 0, sm.width, sm.height);
  const imgArea = sm.width * sm.height, longSide = Math.max(sm.width, sm.height);
  const trash = []; const mk = m => { trash.push(m); return m; };
  let cands = [];
  try {
    const src = mk(CV.imread(sm));
    const gray = mk(new CV.Mat()); CV.cvtColor(src, gray, CV.COLOR_RGBA2GRAY);
    const blur = mk(new CV.Mat()); CV.GaussianBlur(gray, blur, new CV.Size(5, 5), 0);
    const k5 = mk(CV.getStructuringElement(CV.MORPH_RECT, new CV.Size(5, 5)));
    const masks = [];
    for (const [lo, hi] of [[20, 60], [50, 150]]) {
      const e = mk(new CV.Mat()); CV.Canny(blur, e, lo, hi);
      CV.dilate(e, e, k5); CV.morphologyEx(e, e, CV.MORPH_CLOSE, k5); masks.push(e);
    }
    const otsu = mk(new CV.Mat()); CV.threshold(blur, otsu, 0, 255, CV.THRESH_BINARY + CV.THRESH_OTSU);
    const inv = mk(new CV.Mat()); CV.bitwise_not(otsu, inv);
    for (const m of [otsu, inv]) { CV.morphologyEx(m, m, CV.MORPH_OPEN, k5); CV.morphologyEx(m, m, CV.MORPH_CLOSE, k5); masks.push(m); }

    for (const m of masks) {
      const cs = mk(new CV.MatVector()), h = mk(new CV.Mat());
      CV.findContours(m, cs, h, CV.RETR_LIST, CV.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < cs.size(); i++) {
        const c = cs.get(i);
        try {
          const area = CV.contourArea(c);
          if (area < imgArea * 0.02 || area > imgArea * 0.93) continue;
          const peri = CV.arcLength(c, true);
          const ap = new CV.Mat(); CV.approxPolyDP(c, ap, 0.02 * peri, true);
          let pts = null;
          if (ap.rows === 4 && CV.isContourConvex(ap)) {
            const qa = CV.contourArea(ap);
            if (qa > 0 && area / qa > 0.8) { pts = []; for (let j = 0; j < 4; j++) pts.push({ x: ap.data32S[j * 2], y: ap.data32S[j * 2 + 1] }); }
          }
          ap.delete();
          if (!pts) {
            const r = CV.minAreaRect(c), ra = r.size.width * r.size.height;
            if (ra > 0 && area / ra > 0.9) pts = CV.RotatedRect.points(r).map(p => ({ x: p.x, y: p.y }));
          }
          if (!pts) continue;
          pts = pts.map(p => ({ x: clamp(p.x, 0, sm.width), y: clamp(p.y, 0, sm.height) }));
          const o = orderPts(pts);
          const w = Math.max(dist(o[0], o[1]), dist(o[3], o[2])), hh = Math.max(dist(o[0], o[3]), dist(o[1], o[2]));
          if (Math.min(w, hh) < 0.05 * longSide || Math.max(w, hh) / Math.min(w, hh) > 6) continue;
          const cx = pts.reduce((a, p) => a + p.x, 0) / 4, cy = pts.reduce((a, p) => a + p.y, 0) / 4;
          const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
          cands.push({ pts: o, area: polyArea(o), c: { x: cx, y: cy }, bb: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
        } finally { c.delete(); }
      }
    }
  } finally { trash.forEach(m => { try { m.delete(); } catch (e) {} }); }

  // 去重（bbox IoU）
  cands.sort((a, b) => b.area - a.area);
  const iou = (a, b) => {
    const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]), x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
    const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i;
    return u > 0 ? i / u : 0;
  };
  const uniq = [];
  for (const c of cands) if (!uniq.some(k => iou(k.bb, c.bb) > 0.6)) uniq.push(c);
  // 包含關係：內部小框（照片、文字區）丟掉；若大框包住 ≥2 個大小合理的框，則大框視為桌面／紙張丟掉
  const kids = k => uniq.filter(c => c !== k && c.area < k.area && inPoly(c.c, k.pts));
  const dropBig = k => k.area > imgArea * 0.5 && kids(k).filter(c => c.area > imgArea * 0.05).length >= 2;
  const dropped = new Set(uniq.filter(dropBig));
  let res = uniq.filter(c => !dropped.has(c) && !uniq.some(k => k !== c && !dropped.has(k) && k.area > c.area && inPoly(c.c, k.pts)));
  res = res.slice(0, 12).sort((a, b) => (Math.abs(a.c.y - b.c.y) > longSide * 0.12 ? a.c.y - b.c.y : a.c.x - b.c.x));
  return res.map(r => r.pts.map(p => ({ x: p.x / s, y: p.y / s })));
}
function fallbackQuad(c) {
  const mx = c.width * 0.02, my = c.height * 0.02;
  return [{ x: mx, y: my }, { x: c.width - mx, y: my }, { x: c.width - mx, y: c.height - my }, { x: mx, y: c.height - my }];
}

function fullQuad(c) {
  return [{ x: 0, y: 0 }, { x: c.width, y: 0 }, { x: c.width, y: c.height }, { x: 0, y: c.height }];
}

/* ========== 透視校正裁切 ========== */
function warp(srcMat, pts) {
  const o = orderPts(pts);
  let quad = o;
  let w = Math.max(dist(o[0], o[1]), dist(o[3], o[2])), h = Math.max(dist(o[0], o[3]), dist(o[1], o[2]));
  if (h > w) { quad = [o[3], o[0], o[1], o[2]]; [w, h] = [h, w]; } // 預設轉成橫向
  const sc = Math.min(1, CROP_MAX / Math.max(w, h));
  const W = Math.max(8, Math.round(w * sc)), H = Math.max(8, Math.round(h * sc));
  const a = CV.matFromArray(4, 1, CV.CV_32FC2, quad.flatMap(p => [p.x, p.y]));
  const b = CV.matFromArray(4, 1, CV.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
  const M = CV.getPerspectiveTransform(a, b), dst = new CV.Mat();
  CV.warpPerspective(srcMat, dst, M, new CV.Size(W, H), CV.INTER_CUBIC, CV.BORDER_REPLICATE, new CV.Scalar());
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  CV.imshow(out, dst);
  a.delete(); b.delete(); M.delete(); dst.delete();
  return out;
}
function buildCrops(img, canvas) {
  const m = CV.imread(canvas);
  try { for (const q of img.quads) q.crop = warp(m, q.pts); } finally { m.delete(); }
}

/* ========== 檔案處理 ========== */
async function processFiles(files) {
  files = [...files].filter(f => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|bmp|gif)$/i.test(f.name));
  if (!files.length) return;
  try { await cvReady; } catch { alert('影像處理引擎載入失敗，請確認網路連線後重新整理。'); return; }
  for (let i = 0; i < files.length; i++) {
    setStatus(`處理中 ${i + 1}/${files.length}：${files[i].name}`);
    await tick();
    try {
      const canvas = await fileToCanvas(files[i]);
      const img = { id: S.nextId++, name: files[i].name, file: files[i], quads: [], fallback: false };
      let list = detectQuads(canvas);
      if (!list.length) { list = [fallbackQuad(canvas)]; img.fallback = true; }
      img.quads = list.map(p => ({ pts: p, on: true, rot: 0, crop: null }));
      buildCrops(img, canvas);
      S.images.push(img); renderList(); schedule();
    } catch (e) {
      console.error(e);
      alert(`無法處理「${files[i].name}」：${e.message || e}\n（HEIC 格式在部分瀏覽器不支援，請改用 JPG/PNG）`);
    }
  }
  setStatus('');
}

/* ========== 類型判斷（證件 / 存摺 / 其他） ========== */
const KIND_NAME = { card: '證件', book: '存摺', other: '其他' };
function kindOf(crop, type) {
  if (type && type !== 'auto') return type;   // 存摺只會在使用者手動選取時才套用，不自動判斷
  const r = Math.max(crop.width, crop.height) / Math.min(crop.width, crop.height);
  return (r >= 1.4 && r < 1.8) ? 'card' : 'other';
}
function longMM(kind, st) { return kind === 'card' ? CARD_LONG : kind === 'book' ? st.passbookLong : st.otherLong; }

/* ========== 清單 UI ========== */
function drawThumb(cnv, crop, rot) {
  const odd = rot % 2, cw = odd ? crop.height : crop.width, ch = odd ? crop.width : crop.height;
  const s = Math.min(150 / cw, 100 / ch);
  cnv.width = Math.max(1, Math.round(cw * s)); cnv.height = Math.max(1, Math.round(ch * s));
  const x = cnv.getContext('2d'); x.save(); x.translate(cnv.width / 2, cnv.height / 2); x.rotate(rot * Math.PI / 2);
  x.drawImage(crop, -crop.width * s / 2, -crop.height * s / 2, crop.width * s, crop.height * s); x.restore();
}
function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  kids.forEach(k => e.append(k)); return e;
}
function renderList() {
  const box = $('#list'); box.innerHTML = '';
  if (!S.images.length) { box.append(el('p', { className: 'muted', textContent: '尚未選擇圖片' })); return; }
  S.images.forEach(img => {
    const g = el('div', { className: 'group' });
    const head = el('div', { className: 'ghead' }, el('span', { className: 'name', textContent: img.name }));
    const bAdj = el('button', { className: 'sm', textContent: '調整框選' }); bAdj.onclick = () => openEditor(img);
    const bFull = el('button', { className: 'sm', textContent: '整張為證件', title: '把整張照片視為單一證件（適用滿版拍攝）' });
    bFull.onclick = async () => {
      setStatus('套用整張…'); await tick();
      try {
        const cv = await fileToCanvas(img.file);
        img.quads = [{ pts: fullQuad(cv), on: true, rot: 0, type: 'card', crop: null }]; img.fallback = false;
        buildCrops(img, cv);
      } catch (e) { alert('處理失敗：' + (e.message || e)); }
      setStatus(''); renderList(); schedule();
    };
    const bDel = el('button', { className: 'sm danger', textContent: '移除' });
    bDel.onclick = () => { S.images = S.images.filter(i => i !== img); renderList(); schedule(); };
    head.append(bAdj, bFull, bDel); g.append(head);
    if (img.fallback) g.append(el('p', { className: 'warn', textContent: '未偵測到證件，已先以整張圖處理；可按「調整框選」手動框出。' }));
    const chips = el('div', { className: 'chips' });
    if (!img.quads.length) chips.append(el('span', { className: 'muted', textContent: '（沒有任何框）' }));
    img.quads.forEach((q, idx) => {
      const chip = el('div', { className: 'chip' + (q.on ? '' : ' off') });
      const cnv = el('canvas'); drawThumb(cnv, q.crop, q.rot);
      const cb = el('input', { type: 'checkbox', checked: q.on });
      cb.onchange = () => { q.on = cb.checked; chip.classList.toggle('off', !q.on); schedule(); };
      const rl = el('button', { className: 'sm', textContent: '↺', title: '逆時針轉90°' });
      const rr = el('button', { className: 'sm', textContent: '↻', title: '順時針轉90°' });
      rl.onclick = () => { q.rot = (q.rot + 3) % 4; drawThumb(cnv, q.crop, q.rot); schedule(); };
      rr.onclick = () => { q.rot = (q.rot + 1) % 4; drawThumb(cnv, q.crop, q.rot); schedule(); };
      const sel = el('select', { className: 'kind' });
      [['auto', '自動'], ['book', '存摺'], ['card', '證件'], ['other', '其他']].forEach(([v, t]) => sel.append(el('option', { value: v, textContent: t })));
      sel.value = q.type || 'auto';
      const cap = el('div', { className: 'cap' });
      const upd = () => { const k = kindOf(q.crop, q.type), st = settings(); cap.textContent = `${KIND_NAME[k]}・長邊 ${longMM(k, st)}mm`; };
      sel.onchange = () => { q.type = sel.value; upd(); schedule(); };
      q.updCap = upd; upd();
      chip.append(cnv, el('div', { className: 'cb' }, el('label', {}, cb, `#${idx + 1}`), rl, rr), sel, cap);
      chips.append(chip);
    });
    g.append(chips); box.append(g);
  });
}

/* ========== 裝箱（MaxRects BSSF） ========== */
class MaxRects {
  constructor(W, H) { this.free = [{ x: 0, y: 0, w: W, h: H }]; }
  insert(w, h, rot) {
    let best = null;
    for (const f of this.free) for (const r of (rot ? [0, 1] : [0])) {
      const ww = r ? h : w, hh = r ? w : h;
      if (ww <= f.w + 1e-6 && hh <= f.h + 1e-6) {
        const s = Math.min(f.w - ww, f.h - hh), l = Math.max(f.w - ww, f.h - hh);
        if (!best || s < best.s - 1e-9 || (Math.abs(s - best.s) < 1e-9 && l < best.l)) best = { x: f.x, y: f.y, w: ww, h: hh, r, s, l };
      }
    }
    if (!best) return null;
    this.split(best); return best;
  }
  split(p) {
    const out = [];
    for (const f of this.free) {
      if (p.x >= f.x + f.w || p.x + p.w <= f.x || p.y >= f.y + f.h || p.y + p.h <= f.y) { out.push(f); continue; }
      if (p.x > f.x) out.push({ x: f.x, y: f.y, w: p.x - f.x, h: f.h });
      if (p.x + p.w < f.x + f.w) out.push({ x: p.x + p.w, y: f.y, w: f.x + f.w - p.x - p.w, h: f.h });
      if (p.y > f.y) out.push({ x: f.x, y: f.y, w: f.w, h: p.y - f.y });
      if (p.y + p.h < f.y + f.h) out.push({ x: f.x, y: p.y + p.h, w: f.w, h: f.y + f.h - p.y - p.h });
    }
    const E = 1e-6;
    this.free = out.filter((a, i) => !out.some((b, j) => {
      if (i === j) return false;
      const inside = a.x >= b.x - E && a.y >= b.y - E && a.x + a.w <= b.x + b.w + E && a.y + a.h <= b.y + b.h + E;
      if (!inside) return false;
      const same = Math.abs(a.x - b.x) < E && Math.abs(a.y - b.y) < E && Math.abs(a.w - b.w) < E && Math.abs(a.h - b.h) < E;
      return !same || j < i;
    }));
  }
}
function collectItems() {
  const items = [];
  S.images.forEach(img => img.quads.forEach(q => { if (q.on && q.crop) items.push({ crop: q.crop, rot: q.rot || 0, type: q.type || 'auto' }); }));
  return items;
}
function settings() {
  const n = (id, d) => { const v = parseFloat($('#' + id).value); return isNaN(v) ? d : v; };
  return {
    mode: $('#mode').value, passbookLong: clamp(n('passbookLong', BOOK_LONG), 50, 290), otherLong: clamp(n('otherLong', 120), 20, 290), margin: clamp(n('margin', 10), 0, 50),
    gap: clamp(n('gap', 5), 0, 40), dpi: n('dpi', 200), rot: $('#rot').checked, border: $('#border').checked
  };
}
function pack(items, k, maxPages, W, H, st, shrink) {
  const sized = items.map(it => {
    const w = it.crop.width, h = it.crop.height;
    const sc = longMM(kindOf(it.crop, it.type), st) / Math.max(w, h) * k;
    const bw = w * sc, bh = h * sc, odd = it.rot % 2;
    return { it, bw, bh, ew: odd ? bh : bw, eh: odd ? bw : bh };
  }).sort((a, b) => b.ew * b.eh - a.ew * a.eh);
  const g = st.gap, bins = [];
  for (const s of sized) {
    let placed = null, bin = null;
    for (const b of bins) { const r = b.mr.insert(s.ew + g, s.eh + g, st.rot); if (r) { placed = r; bin = b; break; } }
    let f = 1;
    if (!placed) {
      if (bins.length >= maxPages) return null;
      f = Math.min(1, W / s.ew, H / s.eh);
      if (f < 1) { if (!shrink) return null; f *= 0.999; }
      bin = { mr: new MaxRects(W + g, H + g), list: [] }; bins.push(bin);
      placed = bin.mr.insert(s.ew * f + g, s.eh * f + g, st.rot);
      if (!placed) return null;
    }
    bin.list.push({ crop: s.it.crop, rot: s.it.rot, extra: placed.r, x: placed.x, y: placed.y, w: placed.w - g, h: placed.h - g, bw: s.bw * f, bh: s.bh * f });
  }
  return bins.map(b => b.list);
}
function computeLayout() {
  const st = settings(), items = collectItems();
  if (!items.length) return { st, pages: [] };
  const W = PAGE.w - 2 * st.margin, H = PAGE.h - 2 * st.margin;
  const tryPack = (k, mp, sh) => pack(items, k, mp, W, H, st, sh);
  let k = 1;
  if (st.mode === 'auto') {
    // 自動模式只放大、不縮小：最小倍率 = 1（實際大小）。單頁放不下就維持實際大小並分多頁
    let lo = 1, hi = 2.2;
    if (tryPack(hi, 1, false)) k = hi;
    else if (!tryPack(lo, 1, false)) k = 1;
    else { for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (tryPack(mid, 1, false)) lo = mid; else hi = mid; } k = lo; }
  }
  return { st, pages: tryPack(k, 99, true) || [] };
}

/* ========== 繪製 A4 ========== */
let timer = null;
function schedule() { clearTimeout(timer); timer = setTimeout(renderPages, 120); }
function renderPages() {
  const { st, pages } = computeLayout();
  const host = $('#pages'); host.innerHTML = ''; S.pages = [];
  if (!pages.length) { host.append(el('p', { className: 'muted', textContent: '勾選至少一個項目後，這裡會顯示 A4 預覽' })); return; }
  const pm = st.dpi / 25.4;
  pages.forEach((list, i) => {
    const c = document.createElement('canvas'); c.width = Math.round(PAGE.w * pm); c.height = Math.round(PAGE.h * pm);
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.strokeStyle = '#9aa3b2'; x.lineWidth = Math.max(1, st.dpi / 150);
    list.forEach(p => {
      x.save();
      x.translate((st.margin + p.x + p.w / 2) * pm, (st.margin + p.y + p.h / 2) * pm);
      x.rotate(((p.rot + p.extra) % 4) * Math.PI / 2);
      const dw = p.bw * pm, dh = p.bh * pm;
      x.drawImage(p.crop, -dw / 2, -dh / 2, dw, dh);
      if (st.border) x.strokeRect(-dw / 2, -dh / 2, dw, dh);
      x.restore();
    });
    S.pages.push(c);
    host.append(el('div', { className: 'page' }, c, `第 ${i + 1} / ${pages.length} 頁・${list.length} 件`));
  });
}

/* ========== 匯出 ========== */
const stamp = () => new Date().toISOString().slice(0, 10);
const toBlob = (c, type, q) => new Promise(r => c.toBlob(r, type, q));
function saveBlob(blob, name) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function exportImages(type) {
  if (!S.pages.length) return alert('目前沒有可匯出的內容');
  const ext = type === 'image/png' ? 'png' : 'jpg';
  for (let i = 0; i < S.pages.length; i++) {
    const b = await toBlob(S.pages[i], type, 0.93);
    saveBlob(b, `證件A4_${stamp()}_p${i + 1}.${ext}`); await tick();
  }
}
async function makePDF(canvases) {
  const enc = new TextEncoder(), chunks = [], offs = []; let pos = 0;
  const push = b => { if (typeof b === 'string') b = enc.encode(b); chunks.push(b); pos += b.length; };
  const PW = 595.28, PH = 841.89, n = canvases.length, total = 2 + 3 * n;
  push('%PDF-1.4\n');
  offs[1] = pos; push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  offs[2] = pos; push(`2 0 obj\n<< /Type /Pages /Count ${n} /Kids [${canvases.map((_, i) => `${3 + 3 * i} 0 R`).join(' ')}] >>\nendobj\n`);
  for (let i = 0; i < n; i++) {
    const c = canvases[i], jpg = new Uint8Array(await (await toBlob(c, 'image/jpeg', 0.93)).arrayBuffer());
    const pg = 3 + 3 * i, ct = pg + 1, im = pg + 2;
    offs[pg] = pos; push(`${pg} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${ct} 0 R >>\nendobj\n`);
    const cs = `q ${PW} 0 0 ${PH} 0 0 cm /Im0 Do Q`;
    offs[ct] = pos; push(`${ct} 0 obj\n<< /Length ${cs.length} >>\nstream\n${cs}\nendstream\nendobj\n`);
    offs[im] = pos; push(`${im} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${c.width} /Height ${c.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`);
    push(jpg); push('\nendstream\nendobj\n');
  }
  const xr = pos;
  push(`xref\n0 ${total + 1}\n0000000000 65535 f \n`);
  for (let i = 1; i <= total; i++) push(String(offs[i]).padStart(10, '0') + ' 00000 n \n');
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xr}\n%%EOF`);
  return new Blob(chunks, { type: 'application/pdf' });
}
async function exportPDF() {
  if (!S.pages.length) return alert('目前沒有可匯出的內容');
  setStatus('產生 PDF…'); await tick();
  saveBlob(await makePDF(S.pages), `證件A4_${stamp()}.pdf`); setStatus('');
}
async function shareAll() {
  if (!S.pages.length) return alert('目前沒有可匯出的內容');
  const files = [];
  for (let i = 0; i < S.pages.length; i++) files.push(new File([await toBlob(S.pages[i], 'image/jpeg', 0.93)], `證件A4_${stamp()}_p${i + 1}.jpg`, { type: 'image/jpeg' }));
  if (navigator.canShare && navigator.canShare({ files })) { try { await navigator.share({ files, title: '證件A4排版' }); } catch (e) {} }
  else alert('此瀏覽器不支援系統分享，請改用下載。');
}

/* ========== 框選編輯器 ========== */
const ED = { img: null, canvas: null, quads: [], sel: 0, scale: 1, drag: null };
const edc = $('#edcv');
async function openEditor(img) {
  setStatus('載入影像…'); await tick();
  try { ED.canvas = await fileToCanvas(img.file); } catch (e) { setStatus(''); return alert('無法載入原圖'); }
  setStatus('');
  ED.img = img; ED.sel = 0;
  ED.quads = img.quads.map(q => ({ pts: q.pts.map(p => ({ ...p })), on: q.on, rot: q.rot, type: q.type }));
  $('#edtitle').textContent = '調整框選：' + img.name;
  $('#editor').hidden = false; fitEditor(); drawEditor();
}
function fitEditor() {
  const c = ED.canvas, maxW = Math.min(window.innerWidth - 40, 1000), maxH = window.innerHeight * 0.62;
  ED.scale = Math.min(maxW / c.width, maxH / c.height);
  edc.width = Math.round(c.width * ED.scale); edc.height = Math.round(c.height * ED.scale);
}
function drawEditor() {
  const x = edc.getContext('2d'), sc = ED.scale;
  x.drawImage(ED.canvas, 0, 0, edc.width, edc.height);
  ED.quads.forEach((q, qi) => {
    const o = orderPts(q.pts), selq = qi === ED.sel, col = selq ? '#f59e0b' : '#22d3ee';
    x.beginPath(); o.forEach((p, i) => i ? x.lineTo(p.x * sc, p.y * sc) : x.moveTo(p.x * sc, p.y * sc)); x.closePath();
    x.fillStyle = selq ? 'rgba(245,158,11,.18)' : 'rgba(34,211,238,.14)'; x.fill();
    x.lineWidth = 2; x.strokeStyle = col; x.stroke();
    q.pts.forEach(p => { x.beginPath(); x.arc(p.x * sc, p.y * sc, selq ? 10 : 8, 0, 7); x.fillStyle = col; x.fill(); x.strokeStyle = '#fff'; x.lineWidth = 2; x.stroke(); });
    x.fillStyle = col; x.font = 'bold 16px sans-serif'; x.fillText('#' + (qi + 1), o[0].x * sc + 8, o[0].y * sc + 22);
  });
}
const edPos = e => { const r = edc.getBoundingClientRect(); return { x: (e.clientX - r.left) * edc.width / r.width, y: (e.clientY - r.top) * edc.height / r.height }; };
edc.addEventListener('pointerdown', e => {
  const p = edPos(e); let best = null, bd = 34;
  ED.quads.forEach((q, qi) => q.pts.forEach((pt, pi) => {
    const d = Math.hypot(pt.x * ED.scale - p.x, pt.y * ED.scale - p.y) - (qi === ED.sel ? 8 : 0);
    if (d < bd) { bd = d; best = { qi, pi }; }
  }));
  if (best) { ED.sel = best.qi; ED.drag = best; edc.setPointerCapture(e.pointerId); }
  else {
    const q = ED.quads.findIndex(q => inPoly({ x: p.x / ED.scale, y: p.y / ED.scale }, orderPts(q.pts)));
    if (q >= 0) ED.sel = q;
  }
  drawEditor();
});
edc.addEventListener('pointermove', e => {
  if (!ED.drag) return;
  const p = edPos(e), pt = ED.quads[ED.drag.qi].pts[ED.drag.pi];
  pt.x = clamp(p.x / ED.scale, 0, ED.canvas.width); pt.y = clamp(p.y / ED.scale, 0, ED.canvas.height); drawEditor();
});
['pointerup', 'pointercancel'].forEach(t => edc.addEventListener(t, () => { ED.drag = null; }));
$('#edAdd').onclick = () => {
  const w = ED.canvas.width, h = ED.canvas.height, x0 = w * 0.25, x1 = w * 0.75, y0 = h * 0.3, y1 = h * 0.7;
  ED.quads.push({ pts: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], on: true, rot: 0 });
  ED.sel = ED.quads.length - 1; drawEditor();
};
$('#edFull').onclick = () => {
  ED.quads = [{ pts: fullQuad(ED.canvas), on: true, rot: 0, type: 'card' }]; ED.sel = 0; drawEditor();
};
$('#edDel').onclick = () => { if (ED.quads[ED.sel]) { ED.quads.splice(ED.sel, 1); ED.sel = 0; drawEditor(); } };
$('#edAuto').onclick = () => {
  let l = detectQuads(ED.canvas); if (!l.length) l = [fallbackQuad(ED.canvas)];
  ED.quads = l.map(p => ({ pts: p, on: true, rot: 0 })); ED.sel = 0; drawEditor();
};
$('#edCancel').onclick = () => { $('#editor').hidden = true; ED.canvas = null; };
$('#edOk').onclick = async () => {
  $('#editor').hidden = true; setStatus('重新裁切…'); await tick();
  const img = ED.img; img.quads = ED.quads.map(q => ({ ...q, crop: null })); img.fallback = false;
  try { buildCrops(img, ED.canvas); } catch (e) { alert('裁切失敗：' + e.message); }
  ED.canvas = null; setStatus(''); renderList(); schedule();
};
window.addEventListener('resize', () => { if (!$('#editor').hidden && ED.canvas) { fitEditor(); drawEditor(); } });

/* ========== 事件綁定 ========== */
$('#pick').onclick = () => $('#file').click();
$('#snap').onclick = () => $('#cam').click();
$('#clear').onclick = () => { if (!S.images.length || confirm('清除所有已載入的圖片？')) { S.images = []; renderList(); schedule(); } };
['#file', '#cam'].forEach(id => $(id).addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; processFiles(f); }));
const drop = $('#drop');
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => processFiles(e.dataTransfer.files));
['mode', 'passbookLong', 'otherLong', 'margin', 'gap', 'dpi', 'rot', 'border'].forEach(id => $('#' + id).addEventListener('input', () => {
  S.images.forEach(i => i.quads.forEach(q => q.updCap && q.updCap())); schedule();
}));
$('#dlJpg').onclick = () => exportImages('image/jpeg');
$('#dlPng').onclick = () => exportImages('image/png');
$('#dlPdf').onclick = exportPDF;
$('#share').onclick = shareAll;
if (!(navigator.canShare)) $('#share').hidden = true;
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
renderPages();
