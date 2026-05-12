// app.js -- Markdown2BPMN Web UI
// サーバー不要。convertMarkdown() を直接呼び出す。
// 依存: generate_bpmn.js (先に読み込まれていること), bpmn-js CDN

'use strict';

// ─── 定数 ────────────────────────────────────
const DEBOUNCE_MS = 800;

// ─── bpmn-js 初期化 ───────────────────────────
const viewer = new BpmnJS({
  container: document.getElementById('bpmn-container'),
});

// ─── DOM 参照 ────────────────────────────────
const editor      = document.getElementById('md-editor');
const statusBar   = document.getElementById('status-bar');
const statusText  = statusBar.querySelector('.status-text');
const charCount   = document.getElementById('char-count');
const errorBanner = document.getElementById('error-banner');
const emptyState  = document.getElementById('empty-state');
const btnConvert  = document.getElementById('btn-convert');
const btnExport   = document.getElementById('btn-export');
const btnFit      = document.getElementById('btn-fit');
const divider     = document.getElementById('divider');
const leftPane    = document.getElementById('left-pane');
const mainEl      = document.getElementById('main');

// ─── ステータス / エラー表示 ──────────────────
function setStatus(msg, cls = '') {
  statusBar.className = cls;
  statusText.textContent = msg;
}

function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.classList.add('visible');
  setStatus('変換エラー', 'error');
}

function hideError() {
  errorBanner.classList.remove('visible');
}

function updateCharCount() {
  charCount.textContent = `${editor.value.length.toLocaleString()} 文字`;
}

// ─── BPMN 描画 ───────────────────────────────
let hasDiagram = false;

async function renderBpmn(xmlString) {
  try {
    await viewer.importXML(xmlString);
    viewer.get('canvas').zoom('fit-viewport');
    emptyState.classList.add('hidden');
    btnFit.style.display = 'inline-flex';
    btnExport.disabled = false;
    hasDiagram = true;
  } catch (err) {
    showError('BPMN 描画エラー: ' + err.message);
  }
}

// ─── 変換処理（サーバー不要、直接呼び出し）────
let debounceTimer = null;

async function doConvert() {
  const markdown = editor.value.trim();
  if (!markdown) { setStatus('待機中'); return; }

  setStatus('変換中…', 'converting');
  hideError();

  // 非同期で実行して UI をブロックしない
  await new Promise(resolve => setTimeout(resolve, 0));

  try {
    const bpmn = convertMarkdown(markdown);   // generate_bpmn.js の公開 API
    await renderBpmn(bpmn);
    setStatus(`変換完了 — ${new Date().toLocaleTimeString('ja-JP')}`, 'success');
  } catch (err) {
    showError(err.message);
  }
}

function scheduleConvert() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(doConvert, DEBOUNCE_MS);
}

// ─── エクスポート ────────────────────────────
async function exportBpmn() {
  if (!hasDiagram) return;
  try {
    const { xml } = await viewer.saveXML({ format: true });
    const blob = new Blob([xml], { type: 'application/xml' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const pid  = (editor.value.match(/process_id:\s*(\S+)/) || [])[1] || 'process';
    a.href = url; a.download = `${pid}.bpmn`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    showError('エクスポートエラー: ' + err.message);
  }
}

// ─── ペインリサイズ（ドラッグ）───────────────
let dragging = false;

divider.addEventListener('mousedown', e => {
  dragging = true;
  divider.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
});

document.addEventListener('mousemove', e => {
  if (!dragging) return;
  const r   = mainEl.getBoundingClientRect();
  const pct = Math.min(Math.max((e.clientX - r.left) / r.width * 100, 20), 80);
  leftPane.style.flex  = 'none';
  leftPane.style.width = `${pct}%`;
});

document.addEventListener('mouseup', () => {
  if (!dragging) return;
  dragging = false;
  divider.classList.remove('dragging');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  if (hasDiagram) viewer.get('canvas').zoom('fit-viewport');
});

// ─── イベントリスナー ────────────────────────
editor.addEventListener('input', () => {
  updateCharCount();
  scheduleConvert();
});

editor.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    clearTimeout(debounceTimer);
    doConvert();
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = editor.selectionStart, end = editor.selectionEnd;
    editor.value = editor.value.slice(0, s) + '  ' + editor.value.slice(end);
    editor.selectionStart = editor.selectionEnd = s + 2;
  }
});

btnConvert.addEventListener('click', () => { clearTimeout(debounceTimer); doConvert(); });
btnExport.addEventListener('click', exportBpmn);
btnFit.addEventListener('click', () => { if (hasDiagram) viewer.get('canvas').zoom('fit-viewport'); });

// ─── 初期化 ──────────────────────────────────
// 左:右 = 1:3 の初期幅
leftPane.style.flex  = 'none';
leftPane.style.width = '25%';

// sample.js で定義された SAMPLE_MARKDOWN を初期表示
editor.value = SAMPLE_MARKDOWN;
updateCharCount();
setTimeout(doConvert, 300);
