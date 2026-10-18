/* ---------- constants ---------- */
// 與 STUF 記帳工具同在 leekuen.github.io 網域，IndexedDB 名稱必須不同，不然兩邊資料會混在一起。
const DB_NAME = 'coupleExpenseDB';
const DB_VERSION = 1;
const STORE_EXPENSES = 'expenses';
const STORE_META = 'meta';

// 「還款」是結算用的特殊分類：不算花費，只用來沖銷兩人之間的欠款。
const SETTLE_CATEGORY = '💸 還款';
const DEFAULT_PEOPLE = ['力堃', '婍瑞'];
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
// field 指定用哪個幣別的金額（'amountUSD' 或 'amountTWD'）；兩種幣別各算各的，互不換算。
function computeBalances(rows, people, field = 'amountUSD') {
  const known = people.length === 2 ? people : [];
  const paid = {}, consumed = {}, net = {};
  people.forEach((p) => { paid[p] = 0; consumed[p] = 0; net[p] = 0; });
  let total = 0;
  let count = 0;
  for (const r of rows) {
    const amt = Number(r[field]);
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
  syncErrors: {}, // 每個項目最近一次失敗原因，key 是 localId 或 'opt:欄位:值'（只存在記憶體，給「同步狀態」面板看）
  lastSyncError: null, // 最近一次整輪同步失敗 {message, at}
  lastSyncOk: '',
  dupIgnored: [], // 使用者標記「不是重複」的群組 id
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
    if (r.key === 'lastSyncOk') state.lastSyncOk = r.value;
    if (r.key === 'dupIgnored' && Array.isArray(r.value)) state.dupIgnored = r.value;
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
  const skippedOptions = [];
  const queue = state.pendingOptions;
  for (let i = 0; i < queue.length; i++) {
    const opt = queue[i];
    const key = 'opt:' + opt.field + ':' + opt.value;
    try {
      await callSync('addOption', opt);
      delete state.syncErrors[key];
    } catch (e) {
      // 重試也不可能成功的錯誤（下拉選單不是單純清單、找不到欄位）：直接移出佇列，
      // 不要讓「待同步」永遠掛著。這個值在本機和試算表儲存格裡本來就能用。
      if (e.server && /不是簡單清單型態|找不到欄位|缺少要新增的值|不支援的欄位/.test(e.message)) {
        delete state.syncErrors[key];
        skippedOptions.push(opt.value);
        continue;
      }
      console.error('addOption sync failed, will retry later', e);
      state.syncErrors[key] = { message: e.message, at: nowISO() };
      remaining.push(opt);
      if (e.network) { remaining.push(...queue.slice(i + 1)); break; }
    }
  }
  state.pendingOptions = remaining;
  await saveMeta('pendingOptions', remaining);
  if (skippedOptions.length) {
    showToast('這些選項無法自動加進試算表的下拉選單（不影響記帳）：' + skippedOptions.join('、'));
  }
}

/* ---------- expense CRUD (local-first) ---------- */
async function getAllExpenses() {
  const rows = await idbGetAll(STORE_EXPENSES);
  return rows.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.lastModified.localeCompare(a.lastModified));
}

function buildExpenseRecord(fields) {
  return {
    localId: uid(),
    date: fields.date,
    category: fields.category,
    item: fields.item,
    payer: fields.payer,
    method: fields.method,
    amountUSD: fields.amountUSD,
    amountTWD: fields.amountTWD,
    payerShare: fields.payerShare,
    note: fields.note || '',
    lastModified: nowISO(),
    sheetRow: null,
    syncStatus: 'pending-create',
  };
}

async function addExpense(fields) {
  await idbPut(STORE_EXPENSES, buildExpenseRecord(fields));
  await renderAll();
  runSync();
}

// 批次新增只重畫、同步一次（截圖匯入一次可能幾十筆）。
async function addExpensesBatch(fieldsList) {
  for (const fields of fieldsList) await idbPut(STORE_EXPENSES, buildExpenseRecord(fields));
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
// err.network＝這次請求根本沒拿到可用的回應（斷網、網址錯、回傳登入頁而不是 JSON），
// 本輪後面的項目也一定會失敗；err.server＝後端有回應，只是拒絕了這一個請求。
async function callSync(action, payload) {
  let json;
  try {
    const resp = await fetch(state.syncUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, ...payload }),
    });
    json = await resp.json();
  } catch (e) {
    const err = new Error(e instanceof SyntaxError
      ? '伺服器回應不是 JSON，可能是 Apps Script 網址或「誰可以存取」設定有誤'
      : '連線失敗（網路中斷或網址不正確）：' + e.message);
    err.network = true;
    throw err;
  }
  if (json.status !== 'ok') {
    const err = new Error(json.message || '伺服器回報失敗');
    err.server = true;
    throw err;
  }
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
    state.lastSyncError = null;
    state.lastSyncOk = nowISO();
    await saveMeta('lastSyncOk', state.lastSyncOk);
  } catch (e) {
    console.error('sync failed', e);
    state.lastSyncError = { message: e.message, at: nowISO() };
    showToast('同步失敗：' + e.message);
  } finally {
    state.syncing = false;
    await updateSyncBadge();
    await renderAll();
    if (syncQueued) { syncQueued = false; runSync(); }
  }
}

// 舊版後端會把日期儲存格序列化成 UTC 字串（"2026-08-31T16:00:00.000Z"＝GMT+8 的 9/1），
// 這裡轉回台北的日曆日期；也接受手打的 "2026/9/1"。後端已修正時這個函式只是原樣回傳。
function normalizeRemoteDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d)) {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    }
  }
  const m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return s;
}

async function pullFromSheet() {
  const fullPull = !state.lastPullTime;
  const res = await callSync('pull', { since: state.lastPullTime || '' });
  // 單人記帳（STUF）版的後端不會回傳 people。貼錯程式碼時，如果繼續 push，
  // 資料會被寫進錯誤的欄位，所以在這裡直接停下來。
  if (!Array.isArray(res.people)) {
    const err = new Error('後端程式碼不是雙人記帳版（可能貼成單人記帳的了）。請用這個工具設定頁的「複製程式碼」重新貼上並部署新版本');
    err.server = true;
    throw err;
  }
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
    const data = { ...remote.data, date: normalizeRemoteDate(remote.data && remote.data.date) };
    if (local) {
      const localPending = local.syncStatus && local.syncStatus.startsWith('pending');
      const remoteWins = !localPending || remote.lastModified > local.lastModified;
      if (!remoteWins) continue; // 本機的編輯比較新，等一下會被 push 出去
      if (remote.deleted) {
        await idbDelete(STORE_EXPENSES, local.localId);
      } else {
        Object.assign(local, data, { lastModified: remote.lastModified, syncStatus: 'synced', sheetRow: remote.row });
        await idbPut(STORE_EXPENSES, local);
      }
    } else if (!remote.deleted) {
      await idbPut(STORE_EXPENSES, {
        localId: uid(),
        ...data,
        lastModified: remote.lastModified,
        sheetRow: remote.row,
        syncStatus: 'synced',
      });
    }
  }
  if (fullPull) {
    // 完整 pull 會回傳試算表上所有存在的列，所以已同步、但這次沒回來的本機紀錄，
    // 代表那一列已經不存在了（例如列被刪掉、下面的列往上移）。移除它，手機才會跟試算表一致；
    // 還有未同步變更的紀錄不動。
    const seen = new Set(res.rows.filter((r) => !r.deleted).map((r) => r.row));
    for (const r of await idbGetAll(STORE_EXPENSES)) {
      if (r.sheetRow && r.syncStatus === 'synced' && !seen.has(r.sheetRow)) await idbDelete(STORE_EXPENSES, r.localId);
    }
  }
  state.lastPullTime = res.serverTime;
  await saveMeta('lastPullTime', res.serverTime);
}

async function pushPendingToSheet() {
  const rows = await idbGetAll(STORE_EXPENSES);
  const pending = rows.filter((r) => r.syncStatus && r.syncStatus.startsWith('pending')).sort((a, b) => a.lastModified.localeCompare(b.lastModified));
  for (const rec of pending) {
    try {
      await pushOneRecord(rec);
      delete state.syncErrors[rec.localId];
    } catch (e) {
      console.error('push failed for', rec.localId, e);
      state.syncErrors[rec.localId] = { message: e.message, at: nowISO() };
      // 後端只拒絕這一筆時，不能擋住排在後面的紀錄；網路層級的失敗代表後面的也一定會失敗，才中止整輪。
      if (e.network) throw e;
    }
  }
}

async function pushOneRecord(rec) {
  const data = {
    date: rec.date, category: rec.category, item: rec.item, payer: rec.payer, method: rec.method,
    amountUSD: rec.amountUSD, amountTWD: rec.amountTWD, payerShare: rec.payerShare, note: rec.note, lastModified: rec.lastModified,
  };
  const queuedAt = rec.lastModified;

  if (rec.syncStatus === 'pending-create') {
    // localId 讓後端能認得重試的請求（例如手機剛好在伺服器建好列、回應還沒送達時斷線），
    // 回傳既有那列而不是再 append 一列重複的。
    const res = await callSync('create', { data, localId: rec.localId });
    // 重新讀一次而不是把 await 前的舊快照寫回去：請求飛行期間使用者可能又編輯或刪除了這筆，
    // 盲目覆蓋會丟掉編輯，或讓剛刪掉的紀錄復活。
    const current = (await idbGetAll(STORE_EXPENSES)).find((r) => r.localId === rec.localId);
    if (!current) return; // 期間在本機被刪了；試算表上會留下一列孤兒，屬於可接受的罕見情況
    current.sheetRow = res.row;
    current.syncStatus = current.lastModified === queuedAt ? 'synced' : 'pending-update';
    await idbPut(STORE_EXPENSES, current);
  } else if (rec.syncStatus === 'pending-update') {
    await callSync('update', { row: rec.sheetRow, data, localId: rec.localId });
    const current = (await idbGetAll(STORE_EXPENSES)).find((r) => r.localId === rec.localId);
    if (!current) return;
    if (current.lastModified === queuedAt) current.syncStatus = 'synced';
    await idbPut(STORE_EXPENSES, current);
  } else if (rec.syncStatus === 'pending-delete') {
    await callSync('delete', { row: rec.sheetRow, data: { lastModified: rec.lastModified } });
    const current = (await idbGetAll(STORE_EXPENSES)).find((r) => r.localId === rec.localId);
    // 只有在送出刪除之後沒被改過才從本機移除（例如使用者沒有中途又打開編輯）。
    if (current && current.lastModified === queuedAt) await idbDelete(STORE_EXPENSES, rec.localId);
  }
}

/* ---------- 找出可能重複 ---------- */
// 同一天、金額（美金＋台幣）相同是基本條件；再加上付款人與項目名稱也相同＝「很可能重複」，
// 其餘（例如項目不同、或付款人不同）列為「金額相同，請確認」讓使用者自己判斷。
function normItemKey(s) { return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); }

function findDuplicateGroups(rows) {
  const live = rows.filter((r) => r.syncStatus !== 'pending-delete');
  const buckets = new Map();
  for (const r of live) {
    const usd = Number(r.amountUSD) || 0;
    const twd = Number(r.amountTWD) || 0;
    if (!usd && !twd) continue;
    const key = `${r.date}|${usd}|${twd}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  const groups = [];
  for (const recs of buckets.values()) {
    if (recs.length < 2) continue;
    const bySame = new Map();
    for (const r of recs) {
      const k = `${r.payer || ''}|${normItemKey(r.item)}`;
      if (!bySame.has(k)) bySame.set(k, []);
      bySame.get(k).push(r);
    }
    const leftovers = [];
    for (const sub of bySame.values()) {
      if (sub.length >= 2) groups.push({ level: 'strong', recs: sub });
      else leftovers.push(...sub);
    }
    if (leftovers.length >= 2) groups.push({ level: 'weak', recs: leftovers });
  }
  for (const g of groups) g.id = g.recs.map((r) => r.localId).sort().join('+');
  return groups
    .filter((g) => !state.dupIgnored.includes(g.id))
    .sort((a, b) => (a.level === b.level
      ? (b.recs[0].date || '').localeCompare(a.recs[0].date || '')
      : (a.level === 'strong' ? -1 : 1)));
}

let dupInfo = { groups: [], ids: new Set() };

function refreshDupInfo(rows) {
  const groups = findDuplicateGroups(rows);
  dupInfo = { groups, ids: new Set(groups.flatMap((g) => g.recs.map((r) => r.localId))) };
  const btn = $('#dupBtn');
  if (btn) btn.textContent = groups.length ? `🔍 找出可能重複（${groups.length} 組）` : '🔍 找出可能重複';
}

async function openDupModal() {
  const rows = await getAllExpenses();
  const groups = findDuplicateGroups(rows);
  const amountText = (r) => [hasAmount(r, 'amountUSD') ? usdText(r.amountUSD) : '', hasAmount(r, 'amountTWD') ? twdText(r.amountTWD) : ''].filter(Boolean).join(' ＋ ');
  const recHtml = (r) => `
    <div class="dup-rec">
      <div class="dup-rec-main">
        <div class="exp-title">${escapeHtml(r.item || '(未命名)')}</div>
        <div class="exp-meta">${escapeHtml(r.payer || '未填付款人')}付　${escapeHtml(r.category || '')}　${escapeHtml(r.method || '')}${r.syncStatus && r.syncStatus.startsWith('pending') ? '　⏳待同步' : ''}</div>
        ${r.note ? `<div class="exp-meta">${escapeHtml(r.note)}</div>` : ''}
      </div>
      <button class="icon-btn dup-del" data-del="${escapeHtml(r.localId)}">刪除這筆</button>
    </div>`;
  const section = (title, hint, list) => !list.length ? '' : `
    <h4 class="dup-title">${title}</h4>
    <p class="hint">${hint}</p>
    ${list.map((g) => `
      <div class="dup-card">
        <div class="dup-head">${escapeHtml(g.recs[0].date || '')}　${escapeHtml(amountText(g.recs[0]))}</div>
        ${g.recs.map(recHtml).join('')}
        <button class="icon-btn" data-ignore="${escapeHtml(g.id)}">不是重複，忽略這組</button>
      </div>`).join('')}`;

  const strong = groups.filter((g) => g.level === 'strong');
  const weak = groups.filter((g) => g.level === 'weak');
  $('#modalRoot').innerHTML = `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal-sheet">
        <h3>🔍 可能重複的紀錄</h3>
        ${groups.length ? '' : '<div class="empty-state">沒有發現可能重複的紀錄 ✅</div>'}
        ${section('很可能重複', '同一天、同付款人、同項目、同金額。刪掉重複的那筆會影響結算，請確認。', strong)}
        ${section('金額相同，請確認', '同一天、金額相同，但項目或付款人不同，請自己確認是不是同一筆（例如兩個人都記了同一次消費）。', weak)}
        <div class="modal-actions"><button class="cancel-btn" id="cancelBtn">關閉</button></div>
      </div>
    </div>`;
  $('#modalBackdrop').addEventListener('click', async (e) => {
    if (e.target.id === 'modalBackdrop') { closeModal(); return; }
    const delId = e.target.dataset && e.target.dataset.del;
    const ignoreId = e.target.dataset && e.target.dataset.ignore;
    if (delId) {
      if (!confirm('確定要刪除這筆記帳嗎？')) return;
      await deleteExpense(delId);
      await openDupModal();
    } else if (ignoreId) {
      state.dupIgnored.push(ignoreId);
      await saveMeta('dupIgnored', state.dupIgnored);
      await renderAll();
      await openDupModal();
    }
  });
  $('#cancelBtn').addEventListener('click', closeModal);
}

/* ---------- 同步狀態面板 ---------- */
function fmtTime(iso) {
  if (!iso) return '尚無紀錄';
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : d.toLocaleString('zh-TW', { hour12: false });
}

// 哪些項目卡在待同步、為什麼，以及本機合計是怎麼組成的，
// 讓「一直待同步」或「總額跟試算表對不上」可以直接在手機上診斷，而不是靠猜。
async function renderSyncDiag() {
  const box = $('#syncDiag');
  if (!box) return;
  const all = await idbGetAll(STORE_EXPENSES);
  const live = all.filter((r) => r.syncStatus !== 'pending-delete');
  const spent = live.filter((r) => r.category !== SETTLE_CATEGORY);
  const repays = live.length - spent.length;
  const pending = all.filter((r) => r.syncStatus && r.syncStatus.startsWith('pending'));
  const label = { 'pending-create': '新增', 'pending-update': '修改', 'pending-delete': '刪除' };
  const sumUSD = spent.reduce((s, r) => s + (Number(r.amountUSD) || 0), 0);
  const sumTWD = spent.reduce((s, r) => s + (Number(r.amountTWD) || 0), 0);
  const noAmount = spent.filter((r) => !hasAmount(r, 'amountUSD') && !hasAmount(r, 'amountTWD'));

  let html = '';
  if (!state.syncUrl) html += '<div class="diag-error">尚未設定同步網址，資料只存在這支手機上。</div>';
  if (state.lastSyncError) {
    html += `<div class="diag-error">最近一次同步失敗（${escapeHtml(fmtTime(state.lastSyncError.at))}）：${escapeHtml(state.lastSyncError.message)}</div>`;
  }
  html += `<div class="hint">最近一次成功同步：${escapeHtml(fmtTime(state.lastSyncOk))}</div>`;
  html += `<div class="hint">本機共 ${spent.length} 筆消費${repays ? `（另有 ${repays} 筆還款）` : ''}・美金合計 ${usdText(sumUSD)}・台幣合計 ${twdText(sumTWD)}</div>`;
  if (noAmount.length) {
    html += `<div class="hint">其中 ${noAmount.length} 筆沒有任何金額（不計入合計）：${escapeHtml(noAmount.slice(0, 5).map((r) => r.item || '(未命名)').join('、'))}${noAmount.length > 5 ? '…' : ''}</div>`;
  }

  if (!pending.length && !state.pendingOptions.length) {
    html += '<div class="hint">目前沒有待同步項目 ✅</div>';
  } else {
    html += '<div class="diag-list">';
    for (const r of pending) {
      const err = state.syncErrors[r.localId];
      const amt = [hasAmount(r, 'amountUSD') ? usdText(r.amountUSD) : '', hasAmount(r, 'amountTWD') ? twdText(r.amountTWD) : ''].filter(Boolean).join(' ＋ ');
      html += `<div class="diag-item">
        <div><span class="diag-tag">${label[r.syncStatus] || '待處理'}</span> ${escapeHtml(r.date || '')} ${escapeHtml(r.item || '(未命名)')} ${escapeHtml(amt)}${r.sheetRow ? `（試算表第 ${r.sheetRow} 列）` : ''}</div>
        ${err ? `<div class="diag-error">失敗原因：${escapeHtml(err.message)}</div>` : '<div class="hint">還沒收到失敗訊息（可能還沒輪到或正在同步）</div>'}
        <button class="icon-btn" data-discard="${escapeHtml(r.localId)}">放棄同步這筆</button>
      </div>`;
    }
    state.pendingOptions.forEach((o, i) => {
      const err = state.syncErrors['opt:' + o.field + ':' + o.value];
      html += `<div class="diag-item">
        <div><span class="diag-tag">選項</span> ${o.field === 'category' ? '分類' : '付款方式'}：${escapeHtml(o.value)}</div>
        ${err ? `<div class="diag-error">失敗原因：${escapeHtml(err.message)}</div>` : '<div class="hint">還沒收到失敗訊息</div>'}
        <button class="icon-btn" data-discard-opt="${i}">放棄寫入試算表下拉選單</button>
      </div>`;
    });
    html += '</div>';
  }
  box.innerHTML = html;
}

async function discardPending(localId) {
  const rec = (await idbGetAll(STORE_EXPENSES)).find((r) => r.localId === localId);
  if (!rec) return;
  // 新增／刪除：試算表本來就沒有或不該有它，直接從本機移除。修改：保留本機的值，只是不再重試。
  if (rec.syncStatus === 'pending-update') {
    rec.syncStatus = 'synced';
    await idbPut(STORE_EXPENSES, rec);
  } else {
    await idbDelete(STORE_EXPENSES, localId);
  }
  delete state.syncErrors[localId];
  await renderAll();
}

function wireSyncDiag() {
  $('#syncDiag').addEventListener('click', async (e) => {
    const id = e.target.dataset && e.target.dataset.discard;
    const optIdx = e.target.dataset && e.target.dataset.discardOpt;
    if (id) {
      if (!confirm('放棄後這筆不會再嘗試同步。確定嗎？')) return;
      await discardPending(id);
    } else if (optIdx !== undefined) {
      if (!confirm('放棄後這個新選項不會寫進試算表的下拉選單（本機仍可使用）。確定嗎？')) return;
      state.pendingOptions.splice(Number(optIdx), 1);
      await saveMeta('pendingOptions', state.pendingOptions);
      await renderAll();
    }
  });
  $('#retrySyncBtn').addEventListener('click', () => {
    if (!state.syncUrl) { showToast('請先設定 Apps Script 網址'); return; }
    runSync();
  });
  $('#fullResyncBtn').addEventListener('click', async () => {
    if (!state.syncUrl) { showToast('請先設定 Apps Script 網址'); return; }
    if (!confirm('會以試算表為準重建手機上的紀錄：已同步的紀錄改成跟試算表一致，試算表上已不存在的會從手機移除；尚未同步的本機變更會保留。確定嗎？')) return;
    state.lastPullTime = '';
    await saveMeta('lastPullTime', '');
    runSync();
  });
}

/* ---------- rendering ---------- */
async function renderAll() {
  const rows = await getAllExpenses();
  refreshDupInfo(rows);
  renderSummary(rows);
  renderList(rows);
  renderWho();
  await updateSyncBadge();
  await renderSyncDiag();
}

const hasAmount = (r, field) => { const n = Number(r[field]); return Number.isFinite(n) && n !== 0; };
const usdText = (n) => '$' + fmtMoney(n);
const twdText = (n) => 'NT$' + fmtMoney(n);

// 列表／預覽用的金額顯示：有美金就美金在上、台幣在下；只有台幣就直接顯示台幣。
function amountHtml(r) {
  const usd = hasAmount(r, 'amountUSD') ? usdText(r.amountUSD) : '';
  const twd = hasAmount(r, 'amountTWD') ? twdText(r.amountTWD) : '';
  return `${usd || twd}${usd && twd ? `<small>${twd}</small>` : ''}`;
}

function renderSummary(allRows) {
  const rows = allRows.filter((r) => r.syncStatus !== 'pending-delete'); // 已排隊刪除的，從使用者角度已經不存在，不能再算進結算
  // 美金、台幣各自獨立計算（不換算匯率）。
  const usd = computeBalances(rows, state.people, 'amountUSD');
  const twd = computeBalances(rows, state.people, 'amountTWD');
  const spent = rows.filter((r) => r.category !== SETTLE_CATEGORY && (hasAmount(r, 'amountUSD') || hasAmount(r, 'amountTWD')));
  $('#totalUSD').textContent = usdText(usd.total);
  $('#totalTWD').textContent = twdText(twd.total);
  $('#totalCount').textContent = spent.length + ' 筆';
  $('#personSummary').innerHTML = state.people.map((p) => {
    const lines = [];
    if (usd.count || !twd.count) lines.push(`已付 ${usdText(usd.paid[p])} ・ 實際負擔 ${usdText(usd.consumed[p])}`);
    if (twd.count) lines.push(`已付 ${twdText(twd.paid[p])} ・ 實際負擔 ${twdText(twd.consumed[p])}`);
    return `
    <div class="person-row">
      <span class="person-name">${escapeHtml(p)}</span>
      <span class="person-detail">${lines.join('<br>')}</span>
    </div>`;
  }).join('');
  renderSettle(usd, twd);
}

function renderSettle(usd, twd) {
  const textEl = $('#settleText');
  const subEl = $('#settleSub');
  const btn = $('#recordRepayBtn');
  lastSettle = { usd: usd.settle, twd: twd.settle };
  if (state.people.length !== 2) {
    textEl.className = 'settle-text';
    textEl.textContent = '付款人需要剛好兩個人才能結算';
    subEl.textContent = '請到試算表「付款人」欄的資料驗證，設定成剛好兩個名字後再同步。';
    btn.style.display = 'none';
    return;
  }
  // 有紀錄（或有還款）的幣別才列出一行；全部都沒有就顯示打平。
  const lines = [];
  if (usd.count || usd.settle) lines.push({ label: '美金', s: usd.settle, fmt: usdText });
  if (twd.count || twd.settle) lines.push({ label: '台幣', s: twd.settle, fmt: twdText });
  const lineText = (l) => (l.s ? `${l.s.from} 要給 ${l.s.to} ${l.fmt(l.s.amount)}` : '✅ 打平');
  const anyOwed = lines.some((l) => l.s);
  if (!anyOwed) {
    textEl.className = 'settle-text settled';
    textEl.textContent = '✅ 目前兩邊打平';
  } else if (lines.length === 1) {
    textEl.className = 'settle-text';
    textEl.textContent = lineText(lines[0]);
  } else {
    // 兩種幣別都有紀錄：各列一行（其中一種可能已經打平）。
    textEl.className = 'settle-text';
    textEl.innerHTML = lines.map((l) => `<div>${l.label}｜${escapeHtml(lineText(l))}</div>`).join('');
  }
  subEl.textContent = anyOwed ? '實際轉帳或給現金之後，按下面的按鈕記錄還款，結算就會歸零。' : '';
  btn.style.display = anyOwed ? '' : 'none';
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
              ${dupInfo.ids.has(r.localId) ? '<span class="exp-tag dup-tag">⚠️可能重複</span>' : ''}
              ${r.note ? '　' + escapeHtml(r.note) : ''}
            </div>
          </div>
          <div class="exp-amount">${amountHtml(r)}</div>
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

// 分帳方式 chip：標籤會跟著目前選的付款人變（「力堃自己用」「婍瑞全額」）。
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
        <div class="form-row-split">
          <div class="form-row">
            <label>金額（美金）</label>
            <input type="number" inputmode="decimal" id="f_usd" value="${base.amountUSD != null ? base.amountUSD : ''}">
          </div>
          <div class="form-row">
            <label>金額（台幣）</label>
            <input type="number" inputmode="decimal" id="f_twd" value="${base.amountTWD != null ? base.amountTWD : ''}">
          </div>
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
    const payerShare = isSettle ? 0 : resolveSplit();
    const fields = {
      date: $('#f_date').value,
      category,
      payer,
      method,
      item: $('#f_item').value.trim(),
      amountUSD: toAmount($('#f_usd').value),
      amountTWD: toAmount($('#f_twd').value),
      payerShare,
      note: $('#f_note').value.trim(),
    };
    // 美金、台幣至少要填一個；兩個都填時各自獨立計算，不換算匯率。
    if (!fields.date || !fields.item || !category || !payer || !method || (fields.amountUSD == null && fields.amountTWD == null) || payerShare == null) {
      showToast('請填完日期、分類、付款人、付款方式、項目、金額（美金或台幣至少一個）與分帳方式');
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

/* ---------- 截圖匯入（辨識在 claude.ai 完成，不需要 API key） ---------- */
// 截圖上的日期時間一律照銀行顯示的台灣時間填，不做時區換算。
// 台新帳戶的截圖視為 Richart 卡：從支付方式選項中找名稱含 richart 的那個。
function richartMethod() {
  return state.methods.find((m) => normOptionText(m).includes('richart')) || '';
}

function normOptionText(s) { return String(s || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase(); }

// Claude 回傳的分類可能少了 emoji（或 emoji 的變體選擇符不同），所以只比對文字與數字。
function matchOption(value, list) {
  const v = String(value || '').trim();
  if (!v) return '';
  const exact = list.find((o) => o === v);
  if (exact) return exact;
  const n = normOptionText(v);
  return n ? (list.find((o) => normOptionText(o) === n) || '') : '';
}

function toAmount(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// 「💸 還款」是結算專用分類，不是消費，不要讓 Claude 選到它。
function importCategories() { return state.categories.filter((c) => c !== SETTLE_CATEGORY); }

function buildImportPrompt() {
  const today = todayStr();
  return `我會附上一或多張消費截圖（信用卡通知、行動支付、收據、訂單截圖等）。請辨識每一筆「實際消費」，只輸出一個 JSON 陣列，不要輸出任何其他文字或說明。

每筆物件的欄位：
- date：消費日期，格式 YYYY-MM-DD，一律照截圖上銀行顯示的日期填（今天是 ${today}，截圖沒標年份時請用 ${today.slice(0, 4)} 年）
- time：消費時間，24 小時制 HH:mm，照截圖顯示填，看不到就填 ""
- item：商家或品項名稱（保留原文）
- amountUSD：美金金額（數字），截圖是美金才填，否則 null
- amountTWD：台幣金額（數字），截圖是台幣才填，否則 null（截圖同時顯示美金和台幣時，兩個都填）
- category：只能從這些選一個，請原樣輸出：${importCategories().join('、')}
- method：只能從這些選一個，請原樣輸出：${state.methods.join('、')}；判斷不出來填 ""${richartMethod() ? `。若截圖是台新銀行（台新帳戶、台新 App、Richart）的交易，一律填 "${richartMethod()}"，不用再判斷` : ''}
- note：其他補充（例如原始時間、卡號末四碼、小費、稅），沒有就填 ""

規則：
1. 退款、轉帳、餘額、點數、廣告等非消費項目不要列入。
2. 截圖顯示的日期和時間（台灣時間）直接照填，不要做任何時區換算或判斷。
3. 同一筆消費在多張截圖重複出現時只列一次。
4. 金額只填數字，不要幣別符號和千分位逗號。
5. 美金和台幣以外的幣別，金額欄位都填 null，並把原幣別與金額寫進 note（例如「原幣 JPY 1,200」）。
6. 不確定的欄位寧可填 "" 或 null，不要猜。`;
}

function normalizeImportItem(o) {
  if (!o || typeof o !== 'object') return null;
  const amountUSD = toAmount(o.amountUSD);
  const amountTWD = toAmount(o.amountTWD);
  const item = String(o.item || '').trim();
  if (!item && amountUSD == null && amountTWD == null) return null;
  const dateStr = String(o.date || '').trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : todayStr();
  const cats = importCategories();
  const category = matchOption(o.category, cats) || cats.find((c) => normOptionText(c).includes('其他')) || '';
  let method = matchOption(o.method, state.methods);
  // Claude 若只回「台新」或「Richart」而不是選項原文，也歸到 Richart 卡。
  if (!method && /台新|richart/i.test(`${o.method || ''} ${o.note || ''}`)) method = richartMethod();
  const note = ['📸待確認', String(o.time || '').trim(), String(o.note || '').trim()].filter(Boolean).join(' ');
  return { date, category, method, item, amountUSD, amountTWD, note };
}

function parseImportText(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start === -1 || end <= start) throw new Error('找不到 JSON 陣列，請確認有把 Claude 的整段回覆貼進來');
  let arr;
  try { arr = JSON.parse(body.slice(start, end + 1)); } catch (e) { throw new Error('JSON 格式有誤，請請 Claude 重新輸出一次'); }
  if (!Array.isArray(arr)) throw new Error('回覆不是陣列格式');
  return arr.map(normalizeImportItem).filter(Boolean);
}

// 同一天、美金或台幣金額相同，而且不是已排隊刪除或還款的紀錄 → 提醒可能重複。
function looksDuplicate(it, existing) {
  return existing.some((e) =>
    e.syncStatus !== 'pending-delete' && e.category !== SETTLE_CATEGORY && e.date === it.date && (
      (it.amountUSD != null && Number(e.amountUSD) === it.amountUSD) ||
      (it.amountTWD != null && Number(e.amountTWD) === it.amountTWD)));
}

let importDraft = '';

function openImportModal() {
  $('#modalRoot').innerHTML = `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal-sheet">
        <h3>📸 從截圖匯入</h3>
        <ol class="import-steps">
          <li>按下方按鈕複製提示詞。</li>
          <li>打開 claude.ai，貼上提示詞並附上消費截圖（可一次多張），送出。</li>
          <li>把 Claude 回覆的內容整段複製，貼到下面。</li>
        </ol>
        <button class="btn-secondary" id="copyPromptBtn">📋 複製提示詞</button>
        <a class="btn-secondary import-link" href="https://claude.ai/new" target="_blank" rel="noopener">🔗 開啟 claude.ai</a>
        <details class="howto">
          <summary>複製沒反應？手動複製提示詞</summary>
          <textarea id="promptFallback" readonly rows="8"></textarea>
        </details>
        <div class="form-row">
          <label>Claude 的回覆</label>
          <textarea id="importPaste" rows="6" placeholder="貼上 Claude 回覆的 JSON…"></textarea>
        </div>
        <div class="modal-actions">
          <button class="cancel-btn" id="cancelBtn">取消</button>
          <button class="save-btn" id="parseBtn">解析</button>
        </div>
      </div>
    </div>`;
  $('#promptFallback').value = buildImportPrompt();
  $('#importPaste').value = importDraft;
  $('#modalBackdrop').addEventListener('click', (e) => { if (e.target.id === 'modalBackdrop') closeModal(); });
  $('#cancelBtn').addEventListener('click', closeModal);
  $('#copyPromptBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(buildImportPrompt());
      showToast('已複製提示詞');
    } catch (e) {
      showToast('無法自動複製，請展開下方手動複製');
    }
  });
  $('#parseBtn').addEventListener('click', async () => {
    importDraft = $('#importPaste').value;
    let items;
    try { items = parseImportText(importDraft); } catch (e) { showToast(e.message); return; }
    if (!items.length) { showToast('沒有辨識到任何消費紀錄'); return; }
    await showImportPreview(items);
  });
}

async function showImportPreview(items) {
  const existing = await getAllExpenses();
  // 可能重複、或美金台幣都沒有金額（原幣在備註）的預設不勾選。
  const rows = items.map((it) => {
    const dup = looksDuplicate(it, existing);
    const noAmount = it.amountUSD == null && it.amountTWD == null;
    return { it, dup, noAmount, checked: !dup && !noAmount };
  });
  const people = state.people.slice();
  const defaultPayer = people.includes(state.me) ? state.me : people[0];

  $('#modalRoot').innerHTML = `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal-sheet">
        <h3>辨識到 ${rows.length} 筆</h3>
        <p class="hint">勾選要匯入的項目。「可能重複」代表同一天已有相同金額的紀錄；「沒有金額」代表截圖不是美金也不是台幣（原幣在備註）。這兩種預設不勾選。匯入後可逐筆點開修改細節。</p>
        <div id="importList">
          ${rows.map((r, i) => `
            <label class="import-row ${r.dup || r.noAmount ? 'dup' : ''}">
              <input type="checkbox" data-i="${i}" ${r.checked ? 'checked' : ''}>
              <div class="import-main">
                <div class="exp-title">${escapeHtml(r.it.item || '(未命名)')}</div>
                <div class="exp-meta">${escapeHtml(r.it.date)}　${escapeHtml(r.it.category)}　${escapeHtml(r.it.method || '付款方式待選')}${r.dup ? '　⚠️可能重複' : ''}${r.noAmount ? '　⚠️沒有金額' : ''}</div>
                <div class="exp-meta">${escapeHtml(r.it.note)}</div>
              </div>
              <div class="exp-amount">${r.noAmount ? '—' : amountHtml(r.it)}</div>
            </label>`).join('')}
        </div>
        <div class="form-row">
          <label>這一批是誰付的</label>
          ${chipGroupHtml('impPayer', people, defaultPayer, { allowCustom: false })}
        </div>
        <div class="form-row">
          <label>怎麼分</label>
          <div id="impSplitWrap"></div>
        </div>
        <div class="modal-actions">
          <button class="cancel-btn" id="backBtn">返回</button>
          <button class="save-btn" id="importBtnConfirm"></button>
        </div>
      </div>
    </div>`;

  let impShare = 50;
  const drawImpSplit = () => {
    const payer = resolveChipValue('impPayer');
    const other = otherPerson(payer);
    const presets = [[50, '平分'], [100, `${payer}自己用`], [0, `${other || '對方'}全額`]];
    $('#impSplitWrap').innerHTML = `<div class="chip-group" id="impSplitChips">${presets.map(([v, label]) =>
      `<button type="button" class="chip ${v === impShare ? 'selected' : ''}" data-value="${v}">${escapeHtml(label)}</button>`).join('')}</div>`;
    $('#impSplitChips').addEventListener('click', (e) => {
      const btn = e.target.closest('.chip');
      if (!btn) return;
      impShare = Number(btn.dataset.value);
      drawImpSplit();
    });
  };
  wireChipGroup('impPayer', drawImpSplit);
  drawImpSplit();

  const selected = () => [...document.querySelectorAll('#importList input:checked')].map((el) => rows[Number(el.dataset.i)].it);
  const refreshCount = () => {
    const n = selected().length;
    const btn = $('#importBtnConfirm');
    btn.textContent = `匯入 ${n} 筆`;
    btn.disabled = n === 0;
  };
  refreshCount();
  $('#importList').addEventListener('change', refreshCount);
  $('#modalBackdrop').addEventListener('click', (e) => { if (e.target.id === 'modalBackdrop') closeModal(); });
  $('#backBtn').addEventListener('click', openImportModal);
  $('#importBtnConfirm').addEventListener('click', async () => {
    const chosen = selected();
    if (!chosen.length) return;
    const payer = resolveChipValue('impPayer');
    await addExpensesBatch(chosen.map((it) => ({ ...it, payer, payerShare: impShare })));
    importDraft = '';
    closeModal();
    showToast(`已匯入 ${chosen.length} 筆，請逐筆確認細節`);
  });
}

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
    const first = lastSettle && (lastSettle.usd || lastSettle.twd);
    if (!first) return;
    // 兩種幣別的欠款方向理論上一致；若不一致，只預填跟第一筆同一個還款人的那個幣別。
    const payer = first.from;
    openExpenseModal(null, {
      category: SETTLE_CATEGORY, payer, item: '還款',
      amountUSD: lastSettle.usd && lastSettle.usd.from === payer ? lastSettle.usd.amount : null,
      amountTWD: lastSettle.twd && lastSettle.twd.from === payer ? lastSettle.twd.amount : null,
    });
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
  wireSyncDiag();
  loadAppsScriptCode();
  $('#addFab').addEventListener('click', () => openExpenseModal(null));
  $('#importBtn').addEventListener('click', openImportModal);
  $('#dupBtn').addEventListener('click', openDupModal);
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
