/* uPrint 批量打印 - 渲染层逻辑 */
(function () {
  'use strict';

  const API = window.uPrint || null;
  const $ = (id) => document.getElementById(id);

  /* ---------------- 状态 ---------------- */
  const state = {
    files: [],            // { path, name, kind, selected, status, pages, reason }
    engine: null,
    printing: false,
    settings: {
      paperSize: 'A4',
      customW: 210, customH: 297,
      mgTop: 15, mgBottom: 15, mgLeft: 20, mgRight: 20,
      orientation: 'portrait',
      copies: 1,
      color: true,
      printerName: '',
      rangeMode: 'all',
      rangeText: '',
      scale: 100
    }
  };

  const SUPPORTED = /\.(pdf|docx|png|jpe?g|bmp|gif|webp|tiff?)$/i;

  /* ---------------- Toast ---------------- */
  let toastTimer = null;
  function toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 3200);
  }

  /* ---------------- 文件操作 ---------------- */
  function addFiles(paths) {
    let added = 0;
    paths.forEach((p) => {
      if (!p || state.files.some(f => f.path === p)) return;
      const kind = API ? API.fileKind(p) : guessKind(p);
      state.files.push({
        path: p, name: p.split(/[\\/]/).pop(), kind,
        selected: true, status: 'wait', pages: null, reason: ''
      });
      added++;
    });
    if (added) {
      renderList();
      loadMeta();
    }
    return added;
  }
  function guessKind(p) {
    const e = p.split('.').pop().toLowerCase();
    if (e === 'pdf') return 'pdf';
    if (e === 'docx') return 'docx';
    if (['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp', 'tif', 'tiff'].includes(e)) return 'image';
    if (['doc', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'wps', 'et', 'dps'].includes(e)) return 'office';
    return 'other';
  }
  // 异步读取页数（PDF）
  function loadMeta() {
    state.files.forEach((f) => {
      if (f.pages !== null || !API) return;
      if (f.kind === 'pdf') {
        setTimeout(() => {
          f.pages = API.pdfPageCount(f.path);
          updateRowMeta(f);
        }, 0);
      } else if (f.kind === 'image') {
        f.pages = 1;
      }
    });
  }

  const KIND_LABEL = { pdf: 'PDF', docx: 'Word', image: '图片', office: '文档', other: '其他' };

  function renderList() {
    const list = $('fileList');
    const kw = $('searchInput').value.trim().toLowerCase();
    const shown = state.files.filter(f => !kw || f.name.toLowerCase().includes(kw));
    if (!state.files.length) {
      list.innerHTML = '';
      list.appendChild(emptyNode());
      updateCount();
      return;
    }
    list.innerHTML = '';
    shown.forEach((f) => list.appendChild(rowNode(f)));
    updateCount();
  }
  function emptyNode() {
    const d = document.createElement('div');
    d.className = 'empty';
    d.innerHTML = '<div class="big">🖨️</div><div>还没有添加文件</div>' +
      '<div class="drop-hint">点击「添加文件」，或直接把 PDF / Word（.docx）/ 图片拖到这里<br>也可以在 uTools 主框选中文件后进入插件</div>';
    return d;
  }
  function statusHtml(f) {
    if (f.status === 'printing') return '<span class="file-status st-printing"><span class="dot blue"></span>打印中…</span>';
    if (f.status === 'ok') return '<span class="file-status st-ok"><span class="dot green"></span>已打印</span>';
    if (f.status === 'fail') return '<span class="file-status st-fail" title="' + escapeHtml(f.reason || '') + '"><span class="dot orange"></span>' + escapeHtml(shortReason(f.reason)) + '</span>';
    return '<span class="file-status st-wait"><span class="dot gray"></span>待打印</span>';
  }
  function shortReason(r) {
    if (!r) return '失败';
    if (r.indexOf('use-browser-print') >= 0) return '需对话框';
    if (r.indexOf('ps-image-fail') >= 0) return '图片打印失败';
    if (r.indexOf('invalid-printer') >= 0) return '打印机不可用';
    if (r.indexOf('image-not-found') >= 0) return '文件不存在';
    if (r.indexOf('sumatra') >= 0) return 'PDF打印失败';
    if (r.indexOf('windows-pdf-fail') >= 0) return 'PDF原生打印失败';
    if (r.indexOf('docx-print-failed') >= 0) return 'Word文档打印失败';
    if (r.length > 8) return r.slice(0, 8) + '…';
    return r;
  }
  function rowNode(f) {
    const row = document.createElement('div');
    row.className = 'file-row' + (f.selected ? ' selected' : '');
    row.dataset.path = f.path;
    const iconCls = f.kind === 'pdf' ? 'pdf' : f.kind === 'docx' ? 'off' : f.kind === 'image' ? 'img' : f.kind === 'office' ? 'off' : 'oth';
    row.innerHTML =
      '<input type="checkbox" class="ck" ' + (f.selected ? 'checked' : '') + '>' +
      '<div class="file-icon ' + iconCls + '">' + KIND_LABEL[f.kind] + '</div>' +
      '<div class="file-info"><div class="file-name">' + escapeHtml(f.name) + '</div>' +
      '<div class="file-meta">' + metaText(f) + '</div></div>' +
      statusHtml(f) +
      '<button class="file-remove" title="移除">✕</button>';
    row.querySelector('.ck').addEventListener('change', (e) => {
      f.selected = e.target.checked;
      row.classList.toggle('selected', f.selected);
      updateCount();
    });
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('ck') || e.target.classList.contains('file-remove')) return;
      const ck = row.querySelector('.ck');
      ck.checked = !ck.checked;
      f.selected = ck.checked;
      row.classList.toggle('selected', f.selected);
      updateCount();
    });
    row.querySelector('.file-remove').addEventListener('click', () => {
      state.files = state.files.filter(x => x.path !== f.path);
      renderList();
    });
    return row;
  }
  function metaText(f) {
    const pg = f.pages ? (f.pages + ' 页') : (f.kind === 'pdf' ? '读取页数…' : '');
    return [f.path, pg].filter(Boolean).join('　');
  }
  function updateRowMeta(f) {
    const row = document.querySelector('.file-row[data-path="' + cssEscape(f.path) + '"]');
    if (row) {
      const meta = row.querySelector('.file-meta');
      if (meta) meta.textContent = metaText(f);
    }
  }
  function updateCount() {
    const total = state.files.length;
    const sel = state.files.filter(f => f.selected).length;
    $('countText').textContent = '共 ' + total + ' 个文件，已选 ' + sel + ' 个';
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function cssEscape(s) { return s.replace(/"/g, '\\"'); }

  /* ---------------- 设置 ---------------- */
  function collectSettings() {
    const s = state.settings;
    return {
      paperSize: s.paperSize === 'custom' ? null : s.paperSize,
      customWidth: s.paperSize === 'custom' ? Number(s.customW) : 0,
      customHeight: s.paperSize === 'custom' ? Number(s.customH) : 0,
      margins: { top: +s.mgTop, bottom: +s.mgBottom, left: +s.mgLeft, right: +s.mgRight },
      orientation: s.orientation,
      copies: +s.copies,
      color: s.color,
      printerName: s.printerName,
      scaleFactor: +s.scale,
      pageRanges: buildRanges(s)
    };
  }
  // 用户输入 1 基（1-3,5）-> Electron 0 基（0-2,4）
  function buildRanges(s) {
    if (s.rangeMode !== 'custom' || !s.rangeText.trim()) return null;
    const parts = s.rangeText.split(',').map(x => x.trim()).filter(Boolean);
    const out = [];
    for (const p of parts) {
      const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
      if (m) out.push((+m[1] - 1) + '-' + (+m[2] - 1));
      else if (/^\d+$/.test(p)) out.push(String(+p - 1));
    }
    return out.join(',') || null;
  }

  function paperDims() {
    const s = state.settings;
    let w = 210, h = 297;
    if (s.paperSize === 'custom') { w = +s.customW || 210; h = +s.customH || 297; }
    else if (API && API.paperSizes[s.paperSize]) { const d = API.paperSizes[s.paperSize]; w = d.width; h = d.height; }
    if (s.orientation === 'landscape') { const t = w; w = h; h = t; }
    return { w, h };
  }
  function updatePreview() {
    const s = state.settings;
    const pv = $('paperPreview');
    const { w, h } = paperDims();
    pv.className = 'paper-preview ' + s.orientation;
    // 边距盒按纸张比例
    const ml = (+s.mgLeft / w) * 100, mr = (+s.mgRight / w) * 100;
    const mt = (+s.mgTop / h) * 100, mb = (+s.mgBottom / h) * 100;
    const box = $('marginBox');
    box.style.left = ml + '%';
    box.style.top = mt + '%';
    box.style.width = Math.max(0, 100 - ml - mr) + '%';
    box.style.height = Math.max(0, 100 - mt - mb) + '%';
  }
  function bindSettings() {
    const s = state.settings;
    // 纸张
    $('paperTags').addEventListener('click', (e) => {
      const tag = e.target.closest('.paper-tag');
      if (!tag) return;
      document.querySelectorAll('.paper-tag').forEach(t => t.classList.remove('active'));
      tag.classList.add('active');
      s.paperSize = tag.dataset.size;
      $('customSizeBox').style.display = s.paperSize === 'custom' ? 'flex' : 'none';
      save(); updatePreview();
    });
    $('customW').addEventListener('input', e => { s.customW = +e.target.value || 210; save(); updatePreview(); });
    $('customH').addEventListener('input', e => { s.customH = +e.target.value || 297; save(); updatePreview(); });
    // 边距
    [['mgTop', 'mgTop'], ['mgBottom', 'mgBottom'], ['mgLeft', 'mgLeft'], ['mgRight', 'mgRight']].forEach(([id, key]) => {
      $(id).addEventListener('input', e => { s[key] = +e.target.value || 0; save(); updatePreview(); });
    });
    // 方向
    document.querySelectorAll('.orient-card').forEach(card => {
      card.addEventListener('click', () => {
        document.querySelectorAll('.orient-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        s.orientation = card.dataset.orient;
        save(); updatePreview();
      });
    });
    // 打印机
    $('printerSelect').addEventListener('change', e => { s.printerName = e.target.value; save(); });
    $('btnRefreshPrinters').addEventListener('click', loadPrinters);
    // 份数
    $('copies').addEventListener('input', e => { s.copies = Math.max(1, +e.target.value || 1); save(); });
    $('copyMinus').addEventListener('click', () => { s.copies = Math.max(1, s.copies - 1); $('copies').value = s.copies; save(); });
    $('copyPlus').addEventListener('click', () => { s.copies = Math.min(99, s.copies + 1); $('copies').value = s.copies; save(); });
    $('chkColor').addEventListener('change', e => { s.color = e.target.checked; save(); });
    // 页码
    document.querySelectorAll('input[name=rangeMode]').forEach(r => {
      r.addEventListener('change', () => {
        s.rangeMode = document.querySelector('input[name=rangeMode]:checked').value;
        $('rangeInput').disabled = s.rangeMode !== 'custom';
        save();
      });
    });
    $('rangeInput').addEventListener('input', e => { s.rangeText = e.target.value; save(); });
    // 缩放
    $('scaleRange').addEventListener('input', e => {
      s.scale = +e.target.value;
      $('scaleVal').textContent = s.scale + '%';
      save();
    });
  }
  function applySettingsToUI() {
    const s = state.settings;
    document.querySelectorAll('.paper-tag').forEach(t => t.classList.toggle('active', t.dataset.size === s.paperSize));
    $('customSizeBox').style.display = s.paperSize === 'custom' ? 'flex' : 'none';
    $('customW').value = s.customW; $('customH').value = s.customH;
    $('mgTop').value = s.mgTop; $('mgBottom').value = s.mgBottom;
    $('mgLeft').value = s.mgLeft; $('mgRight').value = s.mgRight;
    document.querySelectorAll('.orient-card').forEach(c => c.classList.toggle('active', c.dataset.orient === s.orientation));
    $('copies').value = s.copies;
    $('chkColor').checked = s.color;
    document.querySelectorAll('input[name=rangeMode]').forEach(r => r.checked = r.value === s.rangeMode);
    $('rangeInput').value = s.rangeText;
    $('rangeInput').disabled = s.rangeMode !== 'custom';
    $('scaleRange').value = s.scale;
    $('scaleVal').textContent = s.scale + '%';
    $('printerSelect').value = s.printerName || '';
    updatePreview();
  }
  function save() { API && API.saveSettings && API.saveSettings(state.settings); }
  function restore() {
    if (API && API.loadSettings) {
      const obj = API.loadSettings();
      if (obj) state.settings = Object.assign(state.settings, obj);
    }
  }

  /* ---------------- 引擎 & 打印机 ---------------- */
  state.env = null;
  async function initEngine() {
    if (!API) {
      setBadge('未检测到底层接口（请在 uTools 中运行）', 'err');
      return;
    }
    const env = await API.detectEnv();
    state.env = env;
    state.engine = env.engine;
    if (env.pdfSilent && env.imageSilent) {
      setBadge('🖨️ 静默打印引擎就绪（图片 + PDF）', 'ok');
      $('marginHint').textContent = 'PDF 和图片均由 Windows 原生打印组件处理，纸张、页边距、方向、份数、页码范围和缩放生效。';
    } else if (env.imageSilent) {
      setBadge('图片可静默打印；PDF 使用系统默认阅读器', 'warn');
      $('marginHint').textContent = '图片静默打印已就绪；PDF 会优先交给系统默认阅读器按所选打印机打印，阅读器不支持时将弹出系统打印窗口。';
    } else {
      setBadge('当前系统不支持静默打印，图片将走系统打印对话框', 'err');
    }
    loadPrinters();
  }
  function setBadge(text, cls) {
    const b = $('engineBadge');
    b.textContent = text;
    b.className = 'engine-badge' + (cls ? ' ' + cls : '');
  }
  async function loadPrinters() {
    if (!API || !API.getPrinters) return;
    const sel = $('printerSelect');
    try {
      const list = await API.getPrinters();
      if (!list.length) { sel.innerHTML = '<option value="">系统默认打印机</option>'; return; }
      sel.innerHTML = '<option value="">系统默认打印机</option>' +
        list.map(p => '<option value="' + escapeHtml(p.name) + '">' + escapeHtml(p.name) + (p.isDefault ? '（默认）' : '') + '</option>').join('');
      sel.value = state.settings.printerName || '';
    } catch (e) { /* 忽略 */ }
  }

  /* ---------------- PDF 页面预览 ---------------- */
  /* ---------------- 打印预览（多文件） ---------------- */
  // 预览所有已勾选的 PDF / Word / 图片。「上一页 / 下一页」会跨文件连续翻，另有「上一个 / 下一个文件」直接跳转。
  const previewState = { items: [], fileIndex: 0, page: 0, loading: false, requestId: 0, docxPdf: {} };
  function previewable(f) { return f.kind === 'pdf' || f.kind === 'docx' || f.kind === 'image'; }
  function closePdfPreview() {
    previewState.requestId++;
    previewState.loading = false;
    if (API && API.removePreviewFile) Object.keys(previewState.docxPdf).forEach(k => API.removePreviewFile(previewState.docxPdf[k]));
    previewState.docxPdf = {};
    previewState.items = [];
    $('previewModal').hidden = true;
    $('previewImage').removeAttribute('src');
    $('previewSheet').hidden = true;
  }
  function printableArea() {
    const { w: paperW, h: paperH } = paperDims();
    const s = state.settings;
    return {
      paperW, paperH,
      availableW: Math.max(1, paperW - (+s.mgLeft || 0) - (+s.mgRight || 0)),
      availableH: Math.max(1, paperH - (+s.mgTop || 0) - (+s.mgBottom || 0))
    };
  }
  // 按毫米尺寸把内容放到纸张上（与打印引擎一致：在页边距内居中）
  function placePreviewContent(contentW, contentH, finalScale) {
    const s = state.settings;
    const { paperW, paperH, availableW, availableH } = printableArea();
    const left = (+s.mgLeft || 0) + (availableW - contentW) / 2;
    const top = (+s.mgTop || 0) + (availableH - contentH) / 2;
    const sheet = $('previewSheet');
    const area = $('previewPrintArea');
    sheet.style.setProperty('--paper-w', paperW);
    sheet.style.setProperty('--paper-h', paperH);
    area.style.left = (left / paperW * 100) + '%';
    area.style.top = (top / paperH * 100) + '%';
    area.style.width = (contentW / paperW * 100) + '%';
    area.style.height = (contentH / paperH * 100) + '%';
    const scaleText = finalScale == null ? '' : '，内容最终 ' + Math.round(finalScale) + '%';
    $('previewScaleHint').textContent = '打印预览：' + (s.paperSize === 'custom' ? paperW + '×' + paperH + 'mm' : s.paperSize) + scaleText + '，边距已计入';
  }
  // PDF / Word：按原始尺寸 × 缩放，超出可打印区域时等比缩小
  function applyPreviewLayout(pdfWidthDip, pdfHeightDip) {
    const s = state.settings;
    const { availableW, availableH } = printableArea();
    const contentW = (pdfWidthDip / 96) * 25.4 * (+s.scale || 100) / 100;
    const contentH = (pdfHeightDip / 96) * 25.4 * (+s.scale || 100) / 100;
    const shrink = Math.min(1, availableW / contentW, availableH / contentH);
    placePreviewContent(contentW * shrink, contentH * shrink, (+s.scale || 100) * shrink);
  }
  // 图片：铺满可打印区域后再乘缩放（与图片打印引擎一致）
  function applyImageLayout(imgW, imgH) {
    const s = state.settings;
    const { availableW, availableH } = printableArea();
    const ratio = Math.min(availableW / imgW, availableH / imgH) * (+s.scale || 100) / 100;
    placePreviewContent(imgW * ratio, imgH * ratio, null);
  }
  function loadImageSize(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => reject(new Error('无法加载图片'));
      img.src = url;
    });
  }
  function updatePreviewNav() {
    const items = previewState.items;
    const n = items.length;
    const fi = previewState.fileIndex;
    const item = items[fi];
    if (!item) return;
    const total = item.total;
    const pageText = total ? ('第 ' + (previewState.page + 1) + ' / ' + total + ' 页') : ('第 ' + (previewState.page + 1) + ' 页');
    $('previewPageText').textContent = (n > 1 ? '文件 ' + (fi + 1) + ' / ' + n + ' · ' : '') + pageText;
    $('btnPreviewPrev').disabled = fi === 0 && previewState.page === 0;
    $('btnPreviewNext').disabled = fi === n - 1 && (!total || previewState.page >= total - 1);
    $('btnPreviewPrevFile').disabled = fi === 0;
    $('btnPreviewNextFile').disabled = fi === n - 1;
    $('btnPreviewPrevFile').hidden = n <= 1;
    $('btnPreviewNextFile').hidden = n <= 1;
  }
  const PREVIEW_TITLE = { pdf: 'PDF 预览 · ', docx: 'Word 预览 · ', image: '图片预览 · ' };
  async function showPreview(fileIndex, page) {
    const items = previewState.items;
    if (!items.length || !API) return;
    fileIndex = Math.max(0, Math.min(items.length - 1, fileIndex));
    const item = items[fileIndex];
    const file = item.file;
    page = Math.max(0, item.total ? Math.min(item.total - 1, page) : page);
    const requestId = ++previewState.requestId;
    const stale = () => previewState.requestId !== requestId || $('previewModal').hidden;
    previewState.loading = true;
    previewState.fileIndex = fileIndex;
    previewState.page = item.total ? page : 0;
    $('previewTitle').textContent = (PREVIEW_TITLE[file.kind] || '预览 · ') + file.name;
    updatePreviewNav();
    $('previewLoading').textContent = '正在生成预览…';
    $('previewLoading').hidden = false;
    $('previewSheet').hidden = true;
    try {
      let src;
      if (file.kind === 'image') {
        const url = API.fileUrl(file.path);
        const dims = await loadImageSize(url);
        if (stale()) return;
        applyImageLayout(dims.w, dims.h);
        src = url;
      } else {
        let pdfPath = file.path;
        if (file.kind === 'docx') {
          if (!previewState.docxPdf[file.path]) {
            $('previewLoading').textContent = '正在通过 WPS 生成 Word 预览…';
            const prep = await API.prepareDocxPreview(file.path);
            if (!prep || !prep.ok) throw new Error((prep && prep.reason) || 'WPS 无法生成 Word 预览');
            // 弹窗已关闭，或同一文件在等待期间已生成过，丢弃这份临时 PDF
            if ($('previewModal').hidden) { API.removePreviewFile(prep.pdfPath); return; }
            if (previewState.docxPdf[file.path]) API.removePreviewFile(prep.pdfPath);
            else previewState.docxPdf[file.path] = prep.pdfPath;
            if (prep.pages > 0) item.total = prep.pages;
            if (stale()) return;
          }
          pdfPath = previewState.docxPdf[file.path];
        }
        $('previewLoading').textContent = '正在生成预览…';
        const res = await API.renderPdfPreview(pdfPath, page, file.kind === 'docx');
        if (!res || !res.ok) throw new Error((res && res.reason) || '无法生成预览');
        if (stale()) return;
        if (res.pages > 0) {
          item.total = res.pages;
          if (file.kind === 'pdf') { file.pages = res.pages; updateRowMeta(file); }
        }
        applyPreviewLayout(res.width, res.height);
        // 附加片段，避免 Chromium 复用旧的 data URL 图像缓存
        src = res.dataUrl + '#uprint-' + requestId;
      }
      previewState.page = item.total ? Math.min(page, item.total - 1) : page;
      const image = $('previewImage');
      image.removeAttribute('src');
      image.src = src;
      $('previewSheet').hidden = false;
      $('previewLoading').hidden = true;
    } catch (e) {
      if (!stale()) $('previewLoading').textContent = '预览失败：' + (e && e.message ? e.message : e);
    } finally {
      if (!stale()) { previewState.loading = false; updatePreviewNav(); }
    }
  }
  function stepPreviewPage(delta) {
    const items = previewState.items;
    if (!items.length) return;
    let fi = previewState.fileIndex;
    let pg = previewState.page + delta;
    const total = items[fi].total;
    if (delta > 0 && total && pg >= total) { if (fi >= items.length - 1) return; fi++; pg = 0; }
    if (delta < 0 && pg < 0) { if (fi === 0) return; fi--; pg = items[fi].total ? items[fi].total - 1 : 9999; }
    showPreview(fi, pg);
  }
  function stepPreviewFile(delta) {
    const fi = previewState.fileIndex + delta;
    if (fi < 0 || fi >= previewState.items.length) return;
    showPreview(fi, 0);
  }
  function openPdfPreview() {
    const items = state.files.filter(f => f.selected && previewable(f))
      .map(f => ({ file: f, total: f.kind === 'image' ? 1 : (f.kind === 'pdf' ? (f.pages || 0) : 0) }));
    if (!items.length) { toast('请先勾选要预览的 PDF、Word 或图片', true); return; }
    if (!API || !API.renderPdfPreview) { toast('请在 uTools 中运行后预览', true); return; }
    previewState.items = items;
    previewState.docxPdf = {};
    $('previewModal').hidden = false;
    showPreview(0, 0);
  }

  /* ---------------- 浏览器兜底打印（图片） ---------------- */
  function browserPrintImage(filePath) {
    return new Promise((resolve) => {
      const opt = collectSettings();
      const { w, h } = paperDims();
      const m = opt.margins;
      const url = API ? API.fileUrl(filePath) : ('file:///' + filePath.replace(/\\/g, '/'));
      const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
        '@page{size:' + w + 'mm ' + h + 'mm;margin:' + m.top + 'mm ' + m.right + 'mm ' + m.bottom + 'mm ' + m.left + 'mm;}' +
        'html,body{margin:0;padding:0;}' +
        '.p{width:100%;height:100%;display:flex;align-items:center;justify-content:center;page-break-after:always;}' +
        'img{max-width:100%;max-height:100%;object-fit:contain;}' +
        '</style></head><body><div class="p"><img src="' + url + '"></div></body></html>';
      const blob = new Blob([html], { type: 'text/html' });
      const blobUrl = URL.createObjectURL(blob);
      const iframe = document.createElement('iframe');
      iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
      iframe.src = blobUrl;
      let done = false;
      const finish = (ok) => {
        if (done) return; done = true;
        setTimeout(() => { try { document.body.removeChild(iframe); URL.revokeObjectURL(blobUrl); } catch (e) {} resolve(ok); }, 300);
      };
      iframe.onload = () => {
        try {
          const cw = iframe.contentWindow;
          cw.onafterprint = () => finish(true);
          setTimeout(() => { try { cw.focus(); cw.print(); } catch (e) { finish(false); } }, 300);
          // 用户取消对话框长时间无 afterprint 不做强制失败，给 5 分钟兜底
          setTimeout(() => finish(true), 5 * 60 * 1000);
        } catch (e) { finish(false); }
      };
      document.body.appendChild(iframe);
    });
  }

  // PDF 默认阅读器不支持 PrintTo 时，调用 Chromium 的系统打印窗口。
  function browserPrintPdf(filePath) {
    return new Promise((resolve) => {
      const url = API ? API.fileUrl(filePath) : ('file:///' + filePath.replace(/\\/g, '/'));
      const iframe = document.createElement('iframe');
      iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
      iframe.src = url;
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        setTimeout(() => { try { document.body.removeChild(iframe); } catch (e) {} resolve(ok); }, 300);
      };
      iframe.onload = () => {
        setTimeout(() => {
          try {
            const cw = iframe.contentWindow;
            cw.onafterprint = () => finish(true);
            cw.focus();
            cw.print();
            setTimeout(() => finish(true), 5 * 60 * 1000);
          } catch (e) { finish(false); }
        }, 300);
      };
      document.body.appendChild(iframe);
    });
  }

  function browserPrintFile(filePath) {
    const kind = API ? API.fileKind(filePath) : guessKind(filePath);
    return kind === 'pdf' ? browserPrintPdf(filePath) : browserPrintImage(filePath);
  }

  /* ---------------- 打印主流程 ---------------- */
  async function startPrint() {
    if (state.printing) return;
    const targets = state.files.filter(f => f.selected);
    if (!targets.length) { toast('请先添加并勾选要打印的文件', true); return; }

    const unsupported = targets.filter(f => f.kind === 'office' || f.kind === 'other');
    if (unsupported.length) {
      toast(unsupported.length + ' 个文件类型不支持（Office 请先转 PDF），已跳过', true);
    }
    const printable = targets.filter(f => f.kind === 'pdf' || f.kind === 'docx' || f.kind === 'image');
    if (!printable.length) { toast('没有可打印的文件', true); return; }

    state.printing = true;
    $('btnPrint').disabled = true;
    $('btnPrint').textContent = '⏳ 打印中…';
    $('progressBar').classList.add('on');
    $('progressText').textContent = '0 / ' + printable.length;

    // 重置状态
    printable.forEach(f => { f.status = 'wait'; f.reason = ''; });
    renderList();

    const opt = collectSettings();
    const paths = printable.map(f => f.path);
    const idxOf = (p) => state.files.findIndex(f => f.path === p);

    const setRow = (p, patch) => {
      const i = idxOf(p);
      if (i >= 0) Object.assign(state.files[i], patch);
      renderList();
    };

    let summary;
    try {
      summary = await API.printFiles(paths, opt, (ev) => {
        const i = idxOf(ev.file);
        if (i < 0) return;
        if (ev.status === 'printing') state.files[i].status = 'printing';
        else if (ev.status === 'done') {
          state.files[i].status = ev.ok ? 'ok' : 'fail';
          state.files[i].reason = ev.reason || '';
        }
        renderList();
        const doneN = state.files.filter(f => (f.status === 'ok' || f.status === 'fail')).length;
        const total = state.files.length;
        $('progressBar').firstElementChild.style.width = Math.round(doneN / total * 100) + '%';
        $('progressText').textContent = doneN + ' / ' + total;
      });
    } catch (e) {
      summary = { okCount: 0, failCount: paths.length, results: paths.map(p => ({ file: p, ok: false, reason: String(e) })) };
    }

    // 默认阅读器/静默打印失败时，走系统打印对话框。
    const browserFallbacks = (summary.results || []).filter(r => !r.ok && r.reason && r.reason.indexOf('use-browser-print') >= 0);
    for (const r of browserFallbacks) {
      setRow(r.file, { status: 'printing', reason: '' });
      const ok = await browserPrintFile(r.file);
      setRow(r.file, { status: ok ? 'ok' : 'fail', reason: ok ? '' : '对话框打印取消/失败' });
      r.ok = ok;
      r.engine = 'browser-dialog';
      r.reason = ok ? '' : '对话框打印取消/失败';
    }
    summary.okCount = (summary.results || []).filter(r => r.ok).length;
    summary.failCount = (summary.results || []).length - summary.okCount;

    // 收尾
    state.printing = false;
    $('btnPrint').disabled = false;
    $('btnPrint').innerHTML = '🖨️ 一键批量打印';
    setTimeout(() => $('progressBar').classList.remove('on'), 1500);
    const failList = summary.results.filter(r => !r.ok);
    if (!failList.length) {
      toast('✅ 全部打印任务已发送：' + summary.okCount + ' 个文件');
    } else {
      const reasons = failList.map(r => '• ' + r.name + '：' + (r.reason || '失败')).slice(0, 4).join('\n');
      toast('完成 ' + summary.okCount + ' 个，失败 ' + failList.length + ' 个（鼠标悬停查看原因）', true);
      console.log('uPrint 失败明细：\n' + failList.map(r => r.name + ' -> ' + r.reason).join('\n'));
    }
    $('progressText').textContent = '成功 ' + summary.okCount + '，失败 ' + summary.failCount;
  }

  /* ---------------- 事件绑定 ---------------- */
  function bindEvents() {
    $('btnAdd').addEventListener('click', () => $('filePicker').click());
    $('filePicker').addEventListener('change', (e) => {
      const paths = Array.from(e.target.files).map(f => f.path).filter(p => SUPPORTED.test(p));
      if (!paths.length && e.target.files.length) toast('只支持 PDF / Word（.docx）/ 图片格式', true);
      addFiles(paths);
      e.target.value = '';
    });

    $('btnAddFolder').addEventListener('click', () => $('folderPicker').click());
    $('folderPicker').addEventListener('change', (e) => {
      const paths = Array.from(e.target.files).map(f => f.path).filter(p => SUPPORTED.test(p));
      addFiles(paths);
      e.target.value = '';
    });

    $('btnRemove').addEventListener('click', () => {
      state.files = state.files.filter(f => !f.selected);
      renderList();
    });
    $('btnClear').addEventListener('click', () => { state.files = []; renderList(); });
    $('btnSelectAll').addEventListener('click', () => {
      const allSel = state.files.every(f => f.selected);
      state.files.forEach(f => f.selected = !allSel);
      renderList();
    });
    $('searchInput').addEventListener('input', renderList);

    $('btnToggleSettings').addEventListener('click', () => {
      $('settingsPanel').classList.toggle('collapsed');
    });
    $('btnPrint').addEventListener('click', startPrint);

    $('btnPreview').addEventListener('click', openPdfPreview);
    $('btnClosePreview').addEventListener('click', closePdfPreview);
    $('btnPreviewPrev').addEventListener('click', () => stepPreviewPage(-1));
    $('btnPreviewNext').addEventListener('click', () => stepPreviewPage(1));
    $('btnPreviewPrevFile').addEventListener('click', () => stepPreviewFile(-1));
    $('btnPreviewNextFile').addEventListener('click', () => stepPreviewFile(1));
    document.addEventListener('keydown', (e) => {
      if ($('previewModal').hidden) return;
      if (e.key === 'Escape') closePdfPreview();
      else if (e.key === 'ArrowLeft') stepPreviewPage(-1);
      else if (e.key === 'ArrowRight') stepPreviewPage(1);
      else if (e.key === 'ArrowUp') { e.preventDefault(); stepPreviewFile(-1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); stepPreviewFile(1); }
    });
    $('previewModal').addEventListener('click', (e) => { if (e.target === $('previewModal')) closePdfPreview(); });

    // 拖拽
    const panel = $('filePanel');
    ['dragenter', 'dragover'].forEach(ev => panel.addEventListener(ev, (e) => {
      e.preventDefault(); panel.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach(ev => panel.addEventListener(ev, (e) => {
      e.preventDefault(); panel.classList.remove('dragover');
    }));
    panel.addEventListener('drop', (e) => {
      const paths = Array.from(e.dataTransfer.files).map(f => f.path).filter(Boolean);
      const ok = paths.filter(p => SUPPORTED.test(p));
      if (paths.length && !ok.length) toast('只支持 PDF / Word（.docx）/ 图片格式', true);
      addFiles(ok);
    });

    // uTools 选中文件进入
    window.addEventListener('uprint-files', (e) => {
      const paths = (e.detail || []).filter(p => SUPPORTED.test(p));
      addFiles(paths);
    });
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    restore();
    bindSettings();
    applySettingsToUI();
    bindEvents();
    renderList();
    initEngine();
    // uTools 进入事件可能在脚本加载前触发，preload 做了 CustomEvent，兜底检查
    if (typeof utools !== 'undefined' && utools.onPluginEnter) {
      // 已在 preload 监听；这里无需重复
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
