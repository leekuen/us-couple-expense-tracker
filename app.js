/* ---------- constants ---------- */
// 與 STUF 記帳工具同在 leekuen.github.io 網域，IndexedDB 名稱必須不同，不然兩邊資料會混在一起。
const DB_NAME = 'coupleExpenseDB';
const DB_VERSION = 1;
const STORE_EXPENSES = 'expenses';
const STORE_META = 'meta';

// 「還款」是結算用的特殊分類：不算花費，只用來沖銷兩人之間的欠款。
const SETTLE_CATEGORY = '💸 還款';
const DEFAULT_PEOPLE = ['力堃', '女友'];
const DEFAULT_CATEGORIES = ['🚗 交通', '🏨 住宿', '🍽 三餐', '☕️ 小食', '🎡 娛樂', '🛍️ 購物', '🎲 其他', SETTLE_CATEGORY];
const DEFAULT_METHODS = ['現金', '刷卡', '電子支付'];

/* ---------- 分帳計算（純函式，方便單獨測試） ---------- */
// payerShare = 付款人自己要負擔的百分比：50 平分、100 只有付款人自己用、0 全部是對方的。
function normalizeShare(v) {
  if (v === '' || v == null) return 50;
  const n = Number(v);
  if (!Number.isFinite(n)) return 50;
  return Math.min(100, Math.max(0, n));
}

function describeShare(share, payer, other) {
  const s = normalizeShare(share);
  if (s === 50) return '平分';
  if (s === 100) return `${payer || '付款人'}自己用`;
  if (s === 0) return `${other || '對方'}全額`;
  return `${payer || '付款人'}負擔 ${s}%`;
}

// net[p] > 0 代表別人欠 p 錢；兩人的 net 加起來永遠是 0。
function computeBalances(rows, people) {
  const known = people.length === 2 ? people : [];
  const paid = {}, consumed = {}, net = {};
  people.forEach((p) => { paid[p] = 0; consumed[p] = 0; net[p] = 0; });
  let total = 0;
  let count = 0;
  for (const r of rows) {
    const amt = Number(r.amountUSD);
    if (!Number.isFinite(amt) || !amt) continue;
    const payer = r.payer;
    const other = known.find((p) => p !== payer);
    const attributable = known.includes(payer) && !!other;
    if (r.category === SETTLE_CATEGORY) {
      // 還款：付款人把錢交給對方，等於付款人的欠款減少、對方的債權減少。
      if (attributable) { net[payer] += amt; net[other] -= amt; }
      continue;
    }
    total += amt;
    count += 1;
    if (!attributable) continue; // 付款人不在名單內（舊資料／手動亂填）：只算進總額
    const payerPart = amt * normalizeShare(r.payerShare) / 100;
    paid[payer] += amt;
    consumed[payer] += payerPart;
    consumed[other] += amt - payerPart;
    net[payer] += amt - payerPart;
    net[other] -= amt - payerPart;
  }
  let settle = null;
  if (known.length) {
    const [a, b] = known;
    const diff = Math.round(net[a] * 100) / 100;
    if (diff < 0) settle = { from: a, to: b, amount: -diff };
    else if (diff > 0) settle = { from: b, to: a, amount: diff };
  }
  return { total, count, paid, consumed, net, settle };
}

let db = null;
let state = {
  syncUrl: '',
  lastPullTime: '',
  categories: DEFAULT_CATEGORIES,
  methods: DEFAULT_METHODS,
  people: DEFAULT_PEOPLE,
  me: '', // 這支手機是誰（只存在本機，不同步）
  pendingOptions: [], // [{field:'category'|'method', value}] 從「✏️ 自訂」chip 輸入、等著同步到試算表下拉選單
  syncing: false,
};
let lastSettle = null;

/* ---------- tiny helpers ---------- */
function uid() {
  return 'e_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}
function nowISO() { return new Date().toISOString(); }
function $(sel) { return document.querySelector(sel); }
function fmtMoney(n) {
  if (n == null || n === '') return '';
  const num = Number(n);
  if (Number.isNaN(num)) return '';
  return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function showToast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove('show'), 2400);
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function otherPerson(payer) {
  return state.people.length === 2 ? state.people.find((p) => p !== payer) : undefined;
}

/* ---------- IndexedDB ---------- */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE_EXPENSES)) {
        const store = d.createObjectStore(STORE_EXPENSES, { keyPath: 'localId' });
        store.createIndex('lastModified', 'lastModified');
        store.createIndex('sheetRow', 'sheetRow');
      }
      if (!d.objectStoreNames.contains(STORE_META)) {
        d.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function tx(storeName, mode) {
  return db.transaction(storeName, mode).objectStore(storeName);
}
function idbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName, 'readonly').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbPut(storeName, value) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName, 'readwrite').put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbDelete(storeName, key) {
  return new Promise((resolve, reject) => {
    const req = tx(storeName, 'readwrite').delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
async function loadMeta() {
  const rows = await idbGetAll(STORE_META);
  for (const r of rows) {
    if (r.key === 'syncUrl') state.syncUrl = r.value;
    if (r.key === 'lastPullTime') state.lastPullTime = r.value;
    if (r.key === 'categories' && r.value && r.value.length) state.categories = r.value;
    if (r.key === 'methods' && r.value && r.value.length) state.methods = r.value;
    if (r.key === 'people' && r.value && r.value.length) state.people = r.value;
    if (r.key === 'me' && typeof r.value === 'string') state.me = r.value;
    if (r.key === 'pendingOptions' && Array.isArray(r.value)) state.pendingOptions = r.value;
  }
}
function saveMeta(key, value) {
  return idbPut(STORE_META, { key, value });
}

/* ---------- 這支手機是誰 ---------- */
async function setMe(name) {
  state.me = name;
  await saveMeta('me', name);
  renderWho();
  showToast(`這支手機是「${name}」，新增記帳時會預設由你付款`);
}

function renderWho() {
  const html = state.people.map((p) =>
    `<button type="button" class="chip ${p === state.me ? 'selected' : ''}" data-who="${escapeHtml(p)}">${escapeHtml(p)}</button>`
  ).join('');
  ['#whoChips', '#whoChipsSettings'].forEach((sel) => { const el = $(sel); if (el) el.innerHTML = html; });
  $('#whoCard').style.display = state.me ? 'none' : '';
}

/* ---------- 自訂分類／付款方式（從「✏️ 自訂」chip 輸入） ---------- */
// 先加到本機 chip 清單（離線也能立刻用），並排進佇列，下次同步成功時寫進試算表的下拉選單。
async function registerCustomOption(field, value) {
  const list = field === 'category' ? state.categories : state.methods;
  if (list.includes(value)) return;
  list.push(value);
  await saveMeta(field === 'category' ? 'categories' : 'methods', list);
  if (!state.pendingOptions.some((o) => o.field === field && o.value === value)) {
    state.pendingOptions.push({ field, value });
    await saveMeta('pendingOptions', state.pendingOptions);
  }
}

async function pushPendingOptions() {
  if (!state.pendingOptions.length) return;
  const remaining = [];
  for (const opt of state.pendingOptions) {
    try {
      await callSync('addOption', opt);
    } catch (e) {
      console.error('addOption sync failed, will retry later', e);
      remaining.push(opt);
    }
  }
  state.pendingOptions = remaining;
  await saveMeta('pendingOptions', remaining);
}

/* ---------- expense CRUD (local-first) ---------- */
async function getAllExpenses() {
  const rows = await idbGetAll(STORE_EXPENSES);
  return rows.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.lastModified.localeCompare(a.lastModified));
}

async function addExpense(fields) {
  const rec = {
    localId: uid(),
    date: fields.date,
    category: fields.category,
    item: fields.item,
    payer: fields.payer,
    method: fields.method,
    amountUSD: fields.amountUSD,
    payerShare: fields.payerShare,
    note: fields.note || '',
    lastModified: nowISO(),
    sheetRow: null,
    syncStatus: 'pending-create',
  };
  await idbPut(STORE_EXPENSES, rec);
  await renderAll();
  runSync();
}

async function updateExpense(localId, fields) {
  const rows = await idbGetAll(STORE_EXPENSES);
  const rec = rows.find((r) => r.localId === localId);
  if (!rec) return;
  Object.assign(rec, fields, { lastModified: nowISO() });
  rec.syncStatus = rec.sheetRow ? 'pending-update' : 'pending-create';
  await idbPut(STORE_EXPENSES, rec);
  await renderAll();
  runSync();
}

async function deleteExpense(localId) {
  const rows = await idbGetAll(STORE_EXPENSES);
  const rec = rows.find((r) => r.localId === localId);
  if (!rec) return;
  if (!rec.sheetRow) {
    await idbDelete(STORE_EXPENSES, localId);
  } else {
    rec.syncStatus = 'pending-delete';
    rec.lastModified = nowISO();
    await idbPut(STORE_EXPENSES, rec);
  }
  await renderAll();
  runSync();
}

/* ---------- sync engine ---------- */
// Content-Type text/plain 可以避開 CORS preflight（Apps Script 不回應 OPTIONS）。
async function callSync(action, payload) {
  const resp = await fetch(state.syncUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, ...payload }),
  });
  const json = await resp.json();
  if (json.status !== 'ok') throw new Error(json.message || 'sync failed');
  return json;
}

function setSyncBadge(text, cls) {
  const el = $('#syncBadge');
  el.textContent = text;
  el.className = 'sync-badge' + (cls ? ' ' + cls : '');
}

async function updateSyncBadge() {
  const rows = await idbGetAll(STORE_EXPENSES);
  const pendingCount = rows.filter((r) => r.syncStatus && r.syncStatus.startsWith('pending')).length + state.pendingOptions.length;
  $('#offlineBanner').classList.toggle('show', !navigator.onLine);
  if (state.syncing) { setSyncBadge('🔄 同步中…', 'syncing'); return; }
  if (!state.syncUrl) { setSyncBadge('⚙️ 尚未設定同步', ''); return; }
  if (!navigator.onLine) { setSyncBadge(pendingCount ? `📴 離線・待同步 ${pendingCount}` : '📴 離線', 'offline'); return; }
  if (pendingCount) { setSyncBadge(`⏳ 待同步 ${pendingCount}`, 'pending'); return; }
  setSyncBadge('✅ 已同步', '');
}

let syncQueued = false;
async function runSync() {
  // 下面這個防護前面不能有任何 await：否則兩次連續呼叫（例如一秒內新增又刪除）
  // 會在任何一個把 state.syncing 設成 true 之前同時讀到 false，跑出兩個互相覆蓋的 pull/push。
  if (!state.syncUrl || !navigator.onLine) { await updateSyncBadge(); return; }
  if (state.syncing) { syncQueued = true; return; }
  state.syncing = true;
  await updateSyncBadge();
  try {
    await pullFromSheet();
    await pushPendingOptions();
    await pushPendingToSheet();
  } catch (e) {
    console.error('sync failed', e);
    showToast('同步失敗，稍後會自動重試');
  } finally {
    state.syncing = false;
    await updateSyncBadge();
    await renderAll();
    if (syncQueued) { syncQueued = false; runSync(); }
  }
}

async function pullFromSheet() {
  const res = await callSync('pull', { since: state.lastPullTime || '' });
  if (res.categories && res.categories.length) { state.categories = res.categories; await saveMeta('categories', res.categories); }
  if (res.methods && res.methods.length) { state.methods = res.methods; await saveMeta('methods', res.methods); }
  if (res.people && res.people.length) {
    state.people = res.people;
    await saveMeta('people', res.people);
    // 試算表那邊如果把名字改掉了，舊的「我是誰」就失效，請使用者重選。
    if (state.me && !state.people.includes(state.me)) { state.me = ''; await saveMeta('me', ''); }
  }

  const rows = await idbGetAll(STORE_EXPENSES);
  const bySheetRow = new Map(rows.filter((r) => r.sheetRow).map((r) => [r.sheetRow, r]));

  for (const remote of res.rows) {
    const local = bySheetRow.get(remote.row);
    if (local) {
      const localPending = local.syncStatus && local.syncStatus.startsWith('pending');
      const remoteWins = !localPending || remote.lastModified > local.lastModified;
      if (!remoteWins) continue; // 本機的編輯比較新，等一下會被 push 出去
      if (remote.deleted) {
        await idbDelete(STORE_EXPENSES, local.localId);
      } else {
        Object.assign(local, remote.data, { lastModified: remote.lastModified, syncStatus: 'synced', sheetRow: remote.row });
        await idbPut(STORE_EXPENSES, local);
      }
    } else if (!remote.deleted) {
      await idbPut(STORE_EXPENSES, {
        localId: uid(),
        ...remote.data,
        lastModified: remote.lastModified,
        sheetRow: remote.row,
        syncStatus: 'synced',
      });
    }
  }
  state.lastPullTime = res.serverTime;
  await saveMeta('lastPullTime', res.serverTime);
}

async function pushPendingToSheet() {
  const rows = await idbGetAll(STORE_EXPENSES);
  const pending = rows.filter((r) => r.syncStatus && r.syncStatus.startsWith('pending')).sort((a, b) => a.lastModified.localeCompare(b.lastModified));
  for (const rec of pending) {
    const data = {
      date: rec.date, category: rec.category, item: rec.item, payer: rec.payer, method: rec.method,
      amountUSD: rec.amountUSD, payerShare: rec.payerShare, note: rec.note, lastModified: rec.lastModified,
    };
    const queuedAt = rec.lastModified;

    if (rec.syncStatus === 'pending-create') {
      // localId 讓後端能認得重試的請求（例如手機剛好在伺服器建好列、回應還沒送達時斷線），
      // 回傳既有那列而不是再 append 一列重複的。
      const res = await callSync('create', { data, localId: rec.localId });
      // 重新讀一次而不是把 await 前的舊快照寫回去：請求飛行期間使用者可能又編輯或刪除了這筆，
      // 盲目覆蓋會丟掉編輯，或讓剛刪掉的紀錄復活。
      const current = (await idbGetAll(STORE_EXPENSES)).find((r) => r.localId === rec.localId);
      if (!current) continue; // 期間在本機被刪了；試算表上會留下一列孤兒，屬於可接受的罕見情況
      current.sheetRow = res.row;
      current.syncStatus = current.lastModified === queuedAt ? 'synced' : 'pending-update';
      await idbPut(STORE_EXPENSES, current);
    } else if (rec.syncStatus === 'pending-update') {
      await callSync('update', { row: rec.sheetRow, data, localId: rec.localId });
      const current = (await idbGetAll(STORE_EXPENSES)).find((r) => r.localId === rec.localId);
      if (!current) continue;
      if (current.lastModified === queuedAt) current.syncStatus = 'synced';
      await idbPut(STORE_EXPENSES, current);
    } else if (rec.syncStatus === 'pending-delete') {
      await callSync('delete', { row: rec.sheetRow, data: { lastModified: rec.lastModified } });
      const current = (await idbGetAll(STORE_EXPENSES)).find((r) => r.localId === rec.localId);
      // 只有在送出刪除之後沒被改過才從本機移除（例如使用者沒有中途又打開編輯）。
      if (current && current.lastModified === queuedAt) await idbDelete(STORE_EXPENSES, rec.localId);
    }
  }
}

/* ---------- rendering ---------- */
async function renderAll() {
  const rows = await getAllExpenses();
  renderSummary(rows);
  renderList(rows);
  renderWho();
  await updateSyncBadge();
}

function renderSummary(rows) {
  const b = computeBalances(rows, state.people);
  $('#totalUSD').textContent = '$' + fmtMoney(b.total);
  $('#totalCount').textContent = b.count + ' 筆';
  $('#personSummary').innerHTML = state.people.map((p) => `
    <div class="person-row">
      <span class="person-name">${escapeHtml(p)}</span>
      <span class="person-detail">已付 $${fmtMoney(b.paid[p])} ・ 實際負擔 $${fmtMoney(b.consumed[p])}</span>
    </div>`).join('');
  renderSettle(b);
}

function renderSettle(b) {
  const textEl = $('#settleText');
  const subEl = $('#settleSub');
  const btn = $('#recordRepayBtn');
  lastSettle = b.settle;
  if (state.people.length !== 2) {
    textEl.className = 'settle-text';
    textEl.textContent = '付款人需要剛好兩個人才能結算';
    subEl.textContent = '請到試算表「付款人」欄的資料驗證，設定成剛好兩個名字後再同步。';
    btn.style.display = 'none';
    return;
  }
  if (!b.settle) {
    textEl.className = 'settle-text settled';
    textEl.textContent = '✅ 目前兩邊打平';
    subEl.textContent = '';
    btn.style.display = 'none';
    return;
  }
  textEl.className = 'settle-text';
  textEl.textContent = `${b.settle.from} 要給 ${b.settle.to} $${fmtMoney(b.settle.amount)}`;
  subEl.textContent = '實際轉帳或給現金之後，按下面的按鈕記錄還款，結算就會歸零。';
  btn.style.display = '';
}

function renderList(rows) {
  const container = $('#expenseList');
  if (!rows.length) {
    container.innerHTML = '<div class="empty-state">還沒有記帳紀錄，點右下角 ＋ 開始記帳</div>';
    return;
  }
  const groups = new Map();
  for (const r of rows) {
    const key = r.date || '未填日期';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  let html = '';
  for (const [date, items] of groups) {
    html += `<div class="day-group"><div class="day-group-title">${escapeHtml(date)}</div>`;
    for (const r of items) {
      const pending = r.syncStatus && r.syncStatus.startsWith('pending');
      const isRepay = r.category === SETTLE_CATEGORY;
      const other = otherPerson(r.payer);
      const tags = isRepay
        ? `<span class="exp-tag repay-tag">💸 ${escapeHtml(r.payer || '')} 還給 ${escapeHtml(other || '對方')}</span>`
        : `<span class="exp-tag">${escapeHtml(r.category || '')}</span>
           <span class="exp-tag payer-tag">${escapeHtml(r.payer || '未填付款人')}付・${escapeHtml(describeShare(r.payerShare, r.payer, other))}</span>
           <span class="exp-tag">${escapeHtml(r.method || '')}</span>`;
      html += `
        <div class="expense-item ${pending ? 'pending' : ''} ${isRepay ? 'repay' : ''}" data-id="${r.localId}">
          <div class="exp-left">
            <div class="exp-title">${escapeHtml(r.item || '(未命名)')}</div>
            <div class="exp-meta">
              ${tags}
              ${pending ? '<span class="exp-tag pending-tag">待同步</span>' : ''}
              ${r.note ? '　' + escapeHtml(r.note) : ''}
            </div>
          </div>
          <div class="exp-amount">${r.amountUSD ? '$' + fmtMoney(r.amountUSD) : ''}</div>
        </div>`;
    }
    html += '</div>';
  }
  container.innerHTML = html;
  container.querySelectorAll('.expense-item').forEach((el) => {
    el.addEventListener('click', () => openExpenseModal(el.dataset.id));
  });
}

/* ---------- modal ---------- */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const CUSTOM_CHIP_SENTINEL = '__custom__';

function chipGroupHtml(name, options, selected, opts = {}) {
  const allowCustom = opts.allowCustom !== false;
  const isCustom = allowCustom && !!selected && !options.includes(selected);
  const groupValue = isCustom ? CUSTOM_CHIP_SENTINEL : (selected || '');
  const chips = options.map((o) => `<button type="button" class="chip ${o === selected ? 'selected' : ''}" data-value="${escapeHtml(o)}">${escapeHtml(o)}</button>`).join('');
  const otherLabel = name === 'category' ? '分類' : '付款方式';
  const otherChip = allowCustom ? `<button type="button" class="chip chip-other ${isCustom ? 'selected' : ''}" data-other="1">✏️ 自訂</button>` : '';
  const otherInput = allowCustom ? `<input type="text" id="${name}OtherInput" class="other-input" placeholder="輸入自訂${otherLabel}" value="${isCustom ? escapeHtml(selected) : ''}" style="display:${isCustom ? 'block' : 'none'}">` : '';
  return `<div class="chip-group" id="${name}Chips" data-value="${escapeHtml(groupValue)}">${chips}${otherChip}</div>${otherInput}`;
}
function wireChipGroup(name, onChange) {
  const group = $(`#${name}Chips`);
  const otherInput = $(`#${name}OtherInput`);
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    group.querySelectorAll('.chip').forEach((c) => c.classList.toggle('selected', c === btn));
    if (btn.dataset.other) {
      group.dataset.value = CUSTOM_CHIP_SENTINEL;
      otherInput.style.display = 'block';
      otherInput.focus();
    } else {
      group.dataset.value = btn.dataset.value;
      if (otherInput) { otherInput.style.display = 'none'; otherInput.value = ''; }
    }
    if (onChange) onChange();
  });
  if (otherInput && onChange) otherInput.addEventListener('input', onChange);
}
function resolveChipValue(name) {
  const group = $(`#${name}Chips`);
  if (group.dataset.value === CUSTOM_CHIP_SENTINEL) return $(`#${name}OtherInput`).value.trim();
  return group.dataset.value;
}

// 分帳方式 chip：標籤會跟著目前選的付款人變（「力堃自己用」「女友全額」）。
function drawSplit(share) {
  const payer = resolveChipValue('payer');
  const other = otherPerson(payer);
  const presets = [[50, '平分'], [100, `${payer || '付款人'}自己用`], [0, `${other || '對方'}全額`]];
  const isCustom = !presets.some(([v]) => v === share);
  const chips = presets.map(([v, label]) => `<button type="button" class="chip ${v === share ? 'selected' : ''}" data-value="${v}">${escapeHtml(label)}</button>`).join('');
  $('#splitWrap').innerHTML = `
    <div class="chip-group" id="splitChips" data-value="${isCustom ? CUSTOM_CHIP_SENTINEL : share}">
      ${chips}<button type="button" class="chip chip-other ${isCustom ? 'selected' : ''}" data-other="1">✏️ 自訂 %</button>
    </div>
    <input type="number" id="splitOtherInput" class="other-input" inputmode="decimal" min="0" max="100" step="1"
      placeholder="${escapeHtml(payer || '付款人')}自己負擔幾 %（0–100）" value="${isCustom ? share : ''}" style="display:${isCustom ? 'block' : 'none'}">`;
  const group = $('#splitChips');
  const input = $('#splitOtherInput');
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    group.querySelectorAll('.chip').forEach((c) => c.classList.toggle('selected', c === btn));
    if (btn.dataset.other) {
      group.dataset.value = CUSTOM_CHIP_SENTINEL;
      input.style.display = 'block';
      input.focus();
    } else {
      group.dataset.value = btn.dataset.value;
      input.style.display = 'none';
      input.value = '';
    }
  });
}
// 目前選到的分帳比例；自訂欄位空白或不是數字回傳 null。
function resolveSplit() {
  const group = $('#splitChips');
  if (!group) return null;
  if (group.dataset.value === CUSTOM_CHIP_SENTINEL) {
    const v = $('#splitOtherInput').value.trim();
    if (v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
  }
  return Number(group.dataset.value);
}

async function openExpenseModal(localId, preset) {
  let rec = null;
  if (localId) {
    const rows = await idbGetAll(STORE_EXPENSES);
    rec = rows.find((r) => r.localId === localId);
  }
  const isEdit = !!rec;
  const base = rec || preset || {};
  const people = state.people.slice();
  if (base.payer && !people.includes(base.payer)) people.push(base.payer);
  const selectedCategory = base.category || state.categories[0];
  const selectedMethod = base.method || state.methods[0];
  const selectedPayer = base.payer || (people.includes(state.me) ? state.me : people[0]);
  const initialShare = rec ? normalizeShare(rec.payerShare) : 50;

  const root = $('#modalRoot');
  root.innerHTML = `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal-sheet">
        <h3>${isEdit ? '編輯記帳' : '新增記帳'}</h3>
        <div class="form-row">
          <label>日期</label>
          <input type="date" id="f_date" value="${rec ? rec.date : todayStr()}">
        </div>
        <div class="form-row">
          <label>大項目</label>
          ${chipGroupHtml('category', state.categories, selectedCategory)}
        </div>
        <div class="form-row">
          <label>誰付的</label>
          ${chipGroupHtml('payer', people, selectedPayer, { allowCustom: false })}
        </div>
        <div class="form-row">
          <label>支付方式</label>
          ${chipGroupHtml('method', state.methods, selectedMethod)}
        </div>
        <div class="form-row">
          <label>項目名稱</label>
          <input type="text" id="f_item" value="${rec ? escapeHtml(rec.item) : escapeHtml(base.item || '')}" placeholder="例如：午餐">
        </div>
        <div class="form-row">
          <label>金額（美金）</label>
          <input type="number" inputmode="decimal" id="f_usd" value="${base.amountUSD != null ? base.amountUSD : ''}">
        </div>
        <div class="form-row" id="splitRow">
          <label>怎麼分？</label>
          <div id="splitWrap"></div>
        </div>
        <div class="form-row">
          <label>備註</label>
          <textarea id="f_note">${rec ? escapeHtml(rec.note) : ''}</textarea>
        </div>
        <div class="modal-actions">
          ${isEdit ? '<button class="delete-btn" id="deleteBtn">刪除</button>' : ''}
          <button class="cancel-btn" id="cancelBtn">取消</button>
          <button class="save-btn" id="saveBtn">儲存</button>
        </div>
      </div>
    </div>`;

  let splitShare = initialShare;
  const refreshSplit = () => {
    const cur = resolveSplit();
    if (cur != null) splitShare = cur;
    drawSplit(splitShare);
  };
  // 「還款」不需要分帳比例，直接把整個區塊藏起來。
  const updateSettleMode = () => { $('#splitRow').style.display = resolveChipValue('category') === SETTLE_CATEGORY ? 'none' : ''; };

  wireChipGroup('category', updateSettleMode);
  wireChipGroup('payer', refreshSplit);
  wireChipGroup('method');
  drawSplit(splitShare);
  updateSettleMode();
  $('#modalBackdrop').addEventListener('click', (e) => { if (e.target.id === 'modalBackdrop') closeModal(); });
  $('#cancelBtn').addEventListener('click', closeModal);
  if (isEdit) $('#deleteBtn').addEventListener('click', async () => {
    if (!confirm('確定要刪除這筆記帳嗎？')) return;
    await deleteExpense(localId);
    closeModal();
  });
  $('#saveBtn').addEventListener('click', async () => {
    const category = resolveChipValue('category');
    const payer = resolveChipValue('payer');
    const method = resolveChipValue('method');
    const isSettle = category === SETTLE_CATEGORY;
    const usdRaw = $('#f_usd').value.trim();
    const usd = usdRaw === '' ? null : Number(usdRaw);
    const payerShare = isSettle ? 0 : resolveSplit();
    const fields = {
      date: $('#f_date').value,
      category,
      payer,
      method,
      item: $('#f_item').value.trim(),
      amountUSD: usd != null && Number.isFinite(usd) ? usd : null,
      payerShare,
      note: $('#f_note').value.trim(),
    };
    if (!fields.date || !fields.item || !category || !payer || !method || fields.amountUSD == null || payerShare == null) {
      showToast('請填完日期、分類、付款人、付款方式、項目、金額與分帳方式');
      return;
    }
    // 已存在的值會直接略過；全新的值會馬上加進 chip 清單，並排進佇列等下次同步寫進試算表下拉選單。
    await registerCustomOption('category', category);
    await registerCustomOption('method', method);
    if (isEdit) await updateExpense(localId, fields);
    else await addExpense(fields);
    closeModal();
  });
}
function closeModal() { $('#modalRoot').innerHTML = ''; }

/* ---------- settings ---------- */
async function loadAppsScriptCode() {
  const pre = $('#appsScriptCode');
  try {
    const resp = await fetch('apps-script.gs');
    pre.textContent = await resp.text();
  } catch (e) {
    pre.textContent = '（載入失敗：目前離線，連上網路後重新開啟設定頁）';
  }
}

function wireSettings() {
  $('#syncUrlInput').value = state.syncUrl;
  $('#saveSyncUrlBtn').addEventListener('click', async () => {
    const url = $('#syncUrlInput').value.trim();
    state.syncUrl = url;
    await saveMeta('syncUrl', url);
    $('#syncResult').textContent = url ? '已儲存，開始同步…' : '已清除，記帳將只存在本機。';
    runSync();
  });
  $('#manualSyncBtn').addEventListener('click', () => {
    if (!state.syncUrl) { showToast('請先設定 Apps Script 網址'); return; }
    runSync();
  });
  $('#copyAppsScriptBtn').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('#appsScriptCode').textContent);
    showToast('已複製程式碼');
  });
  $('#clearLocalBtn').addEventListener('click', async () => {
    if (!$('#clearLocalCheckbox').checked) { showToast('請先勾選確認'); return; }
    if (!confirm('確定清除本機所有記帳資料？（不影響雲端試算表）')) return;
    const rows = await idbGetAll(STORE_EXPENSES);
    for (const r of rows) await idbDelete(STORE_EXPENSES, r.localId);
    state.lastPullTime = ''; // 不重設的話，之後 pull 只會拿到「之後有變動」的列，清掉的資料不會回來
    await saveMeta('lastPullTime', '');
    await renderAll();
    showToast('本機資料已清除');
  });
  ['#whoChips', '#whoChipsSettings'].forEach((sel) => {
    $(sel).addEventListener('click', (e) => {
      const b = e.target.closest('[data-who]');
      if (b) setMe(b.dataset.who);
    });
  });
  $('#recordRepayBtn').addEventListener('click', () => {
    if (!lastSettle) return;
    openExpenseModal(null, { category: SETTLE_CATEGORY, payer: lastSettle.from, item: '還款', amountUSD: lastSettle.amount });
  });
}

/* ---------- tabs ---------- */
function switchTab(tabId) {
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === tabId));
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabId));
  $('#addFab').style.display = tabId === 'tab-record' ? '' : 'none';
}
function wireTabs() {
  document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
}

/* ---------- init ---------- */
async function init() {
  db = await openDB();
  await loadMeta();
  wireSettings();
  wireTabs();
  loadAppsScriptCode();
  $('#addFab').addEventListener('click', () => openExpenseModal(null));
  $('#syncBadge').addEventListener('click', () => {
    if (state.syncUrl) runSync();
    else switchTab('tab-settings');
  });
  window.addEventListener('online', () => { showToast('已恢復連線，開始同步'); runSync(); });
  window.addEventListener('offline', () => { showToast('已離線，記帳會先存在手機上'); updateSyncBadge(); });
  await renderAll();
  if (state.syncUrl) runSync();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.error('SW register failed', e));
  }
}

document.addEventListener('DOMContentLoaded', init);
