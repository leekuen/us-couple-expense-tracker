/**
 * 美國共同記帳 — Google 試算表同步後端（貼到「擴充功能 → Apps Script」）
 *
 * 一次性設定：
 *   1. 確認下面的 PEOPLE 是你們兩個人的名字（剛好兩個，已預設為 力堃、婍瑞）。
 *   2. 上方函式選單選「setupSheet」→ 按「執行」（只要做一次，會建立「記帳」分頁、標題列與下拉選單）。
 *   3. 部署 → 新增部署作業 → 網頁應用程式（執行身分：我；誰可以存取：所有人）。
 *   4. 把 /exec 網址貼到記帳工具的「設定」頁，兩支手機都貼同一個網址。
 * 之後每次修改這份程式碼，都要「部署 → 管理部署作業 → 編輯 → 版本選新版本」才會生效。
 *
 * 從舊版升級（還沒有「金額（台幣）」欄的試算表）：貼上新程式碼後，再執行一次 setupSheet，
 * 會自動在「金額（美金）」後面插入台幣欄，既有資料不會遺失；之後別忘了重新部署新版本。
 */
var PEOPLE = ['力堃', '婍瑞'];
var DEFAULT_CATEGORIES = ['🚗 交通', '🏨 住宿', '🍽 三餐', '☕️ 小食', '🎡 娛樂', '🛍️ 購物', '🎲 其他', '💸 還款'];
var DEFAULT_METHODS = ['現金', '刷卡', '電子支付'];

var SHEET_NAME = '記帳';
var HEADERS = [
  '日期', '大項目', '項目名稱', '付款人', '支付方式', '金額（美金）', '金額（台幣）', '付款人負擔比例（%）', '備註',
  '最後修改時間（同步用，勿刪）', '本機記錄ID（同步用，勿刪）'
];
var COL = {
  DATE: 1, CATEGORY: 2, ITEM: 3, PAYER: 4, METHOD: 5, AMOUNT_USD: 6, AMOUNT_TWD: 7, SHARE: 8, NOTE: 9,
  MODIFIED: 10, LOCAL_ID: 11
};
var DATA_COLS = 9; // 前 9 欄是使用者看得到、會編輯的資料；第 10、11 欄是同步用
var OLD_SHARE_HEADER = '付款人負擔比例'; // 舊版第 7 欄的標題（舊版沒有台幣欄）

/** 一次性：建立「記帳」分頁、標題列、下拉選單與格式。可重複執行，不會清掉既有資料；也會升級舊版欄位。 */
function setupSheet() {
  if (PEOPLE.length !== 2) throw new Error('PEOPLE 必須剛好兩個名字');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (isOldLayout_(sheet)) {
    // 舊版：第 7 欄是「付款人負擔比例」。在美金欄後面插一欄給台幣，既有資料整體右移。
    sheet.insertColumnAfter(COL.AMOUNT_USD);
  }
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  var rows = sheet.getMaxRows() - 1;
  sheet.getRange(2, COL.DATE, rows, 1).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(2, COL.AMOUNT_USD, rows, 1).setNumberFormat('#,##0.00');
  sheet.getRange(2, COL.AMOUNT_TWD, rows, 1).setNumberFormat('#,##0');
  sheet.getRange(2, COL.SHARE, rows, 1).setNumberFormat('0');
  setList_(sheet, COL.CATEGORY, DEFAULT_CATEGORIES);
  setList_(sheet, COL.PAYER, PEOPLE);
  setList_(sheet, COL.METHOD, DEFAULT_METHODS);
  sheet.getRange(1, COL.SHARE).setNote('付款人自己要負擔的比例。50 = 平分；100 = 只有付款人自己用；0 = 全部是對方的。');
  sheet.getRange(1, COL.CATEGORY).setNote('「💸 還款」是結算用的特殊分類，請不要改名。');
}

function doPost(e) {
  // 兩支手機可能同時寫入：appendRow 之後接 getLastRow 若被插隊會拿到對方那列的列號，
  // 之後編輯就會寫錯列。整個請求用指令碼鎖排隊處理。
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
  } catch (lockErr) {
    return json_({ status: 'error', message: '伺服器忙碌中，請稍後再試' });
  }
  try {
    var payload = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error('找不到「' + SHEET_NAME + '」分頁，請先執行 setupSheet');
    // 欄位還是舊版就寫入的話，台幣會被寫進「負擔比例」欄，所以直接拒絕。
    if (isOldLayout_(sheet)) throw new Error('請先在 Apps Script 編輯器執行一次 setupSheet，升級試算表欄位');
    ensureBookkeepingColumns_(sheet);
    var tz = ss.getSpreadsheetTimeZone();
    var action = payload.action || 'create';
    var d = payload.data || {};
    var now = new Date().toISOString();

    if (action === 'create') {
      // 冪等：這個裝置如果已經成功建立過、只是回應在網路不穩時沒送達，
      // 重試時用 client 產生的 id 找到既有那列，不能再多 append 一列。
      var localId = String(payload.localId || '').trim();
      if (localId) {
        var existingRow = findRowByLocalId_(sheet, localId);
        if (existingRow) return json_({ status: 'ok', row: existingRow, lastModified: d.lastModified || now });
      }
      sheet.appendRow(dataToRow_(d).concat([d.lastModified || now, localId]));
      return json_({ status: 'ok', row: sheet.getLastRow(), lastModified: d.lastModified || now });
    }

    if (action === 'update') {
      assertDataRow_(payload.row);
      sheet.getRange(payload.row, 1, 1, DATA_COLS + 1).setValues([dataToRow_(d).concat([d.lastModified || now])]);
      // 補寫本機記錄ID，讓舊資料之後重試也受到冪等保護。
      var updLocalId = String(payload.localId || '').trim();
      if (updLocalId) sheet.getRange(payload.row, COL.LOCAL_ID).setValue(updLocalId);
      return json_({ status: 'ok' });
    }

    if (action === 'delete') {
      // 只清空內容、不真的刪列，避免其他列的列號位移；時間戳留著當作墓碑讓另一支手機知道被刪了。
      assertDataRow_(payload.row);
      sheet.getRange(payload.row, 1, 1, DATA_COLS).clearContent();
      sheet.getRange(payload.row, COL.MODIFIED).setValue(d.lastModified || now);
      return json_({ status: 'ok' });
    }

    if (action === 'pull') {
      var since = payload.since || '';
      var lastRow = sheet.getLastRow();
      var rows = [];
      if (lastRow >= 2) {
        var values = sheet.getRange(2, 1, lastRow - 1, DATA_COLS + 1).getValues();
        for (var i = 0; i < values.length; i++) {
          var row = values[i];
          var rowNum = i + 2;
          var hasData = rowHasData_(row);
          var lm = row[DATA_COLS];
          var lmStr = lm instanceof Date ? lm.toISOString() : String(lm || '').trim();
          if (!lmStr && hasData) {
            // 使用者直接在試算表手動新增的列：第一次被 pull 到時補上時間戳，之後才追蹤得到。
            lmStr = now;
            sheet.getRange(rowNum, COL.MODIFIED).setValue(lmStr);
          }
          if (!lmStr) continue;
          if (since && lmStr <= since) continue;
          rows.push({ row: rowNum, deleted: !hasData, lastModified: lmStr, data: rowToData_(row, tz) });
        }
      }
      var opts = getDropdownOptions_(sheet);
      return json_({
        status: 'ok', rows: rows, serverTime: now,
        categories: opts.categories, methods: opts.methods, people: opts.people
      });
    }

    if (action === 'meta') {
      var opts2 = getDropdownOptions_(sheet);
      return json_({ status: 'ok', categories: opts2.categories, methods: opts2.methods, people: opts2.people });
    }

    if (action === 'addOption') {
      var field = payload.field; // 'category' | 'method'
      var newValue = String(payload.value || '').trim();
      if (!newValue) throw new Error('缺少要新增的值');
      var col = field === 'category' ? COL.CATEGORY : (field === 'method' ? COL.METHOD : -1);
      if (col < 1) throw new Error('不支援的欄位：' + field);
      var rule = sheet.getRange(2, col).getDataValidation();
      if (!rule || rule.getCriteriaType() != SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) {
        throw new Error('這個欄位的下拉選單不是簡單清單型態，請直接到試算表「資料 > 資料驗證」手動加選項');
      }
      var existing = rule.getCriteriaValues()[0].slice();
      if (existing.indexOf(newValue) === -1) existing.push(newValue);
      setList_(sheet, col, existing);
      return json_({ status: 'ok', categories: field === 'category' ? existing : undefined, methods: field === 'method' ? existing : undefined });
    }

    throw new Error('未知的 action: ' + action);
  } catch (err) {
    return json_({ status: 'error', message: err.message });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  return ContentService.createTextOutput(
    '✅ 共同記帳連動已就緒，目前列數：' + (sheet ? sheet.getLastRow() : '找不到「' + SHEET_NAME + '」分頁，請先執行 setupSheet')
  );
}

/* ---------- helpers ---------- */
function isOldLayout_(sheet) {
  // 舊版（沒有台幣欄）的特徵：第 7 欄標題是「付款人負擔比例」。
  return String(sheet.getRange(1, 7).getValue()).indexOf(OLD_SHARE_HEADER) !== -1;
}

function assertDataRow_(row) {
  // 第 1 列是標題列，絕對不能被 update/delete 動到。
  if (!row || row < 2) throw new Error('row 不正確');
}

function numOrBlank_(v) {
  return (v != null && v !== '') ? v : '';
}

function dataToRow_(d) {
  return [
    d.date || '', d.category || '', d.item || '', d.payer || '', d.method || '',
    numOrBlank_(d.amountUSD), numOrBlank_(d.amountTWD), numOrBlank_(d.payerShare), d.note || ''
  ];
}

function rowToData_(row, tz) {
  return {
    // Sheets 會把 "2026-09-01" 這種字串自動轉成真正的日期儲存，getValues() 拿回來是 Date 物件，
    // 直接 JSON 序列化會變 UTC，GMT+8 的試算表日期會往前跳一天，所以用試算表自己的時區重新格式化。
    date: normalizeDateCell_(row[0], tz),
    category: row[1], item: row[2], payer: row[3], method: row[4],
    amountUSD: row[5], amountTWD: row[6], payerShare: row[7], note: row[8]
  };
}

function rowHasData_(row) {
  for (var i = 0; i < DATA_COLS; i++) {
    if (row[i] !== '' && row[i] !== null && row[i] !== undefined) return true;
  }
  return false;
}

function normalizeDateCell_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  return v;
}

function setList_(sheet, col, values) {
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(true).build();
  sheet.getRange(2, col, sheet.getMaxRows() - 1, 1).setDataValidation(rule);
}

// 先找完全相同的標題，找不到才用包含比對（避免「付款人」誤中「付款人負擔比例」）。
function findCol_(headers, keyword) {
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i]) === keyword) return i + 1;
  }
  for (var j = 0; j < headers.length; j++) {
    if (String(headers[j]).indexOf(keyword) !== -1) return j + 1;
  }
  return -1;
}

function getDropdownOptions_(sheet) {
  var headers = sheet.getRange(1, 1, 1, DATA_COLS).getValues()[0];
  var catCol = findCol_(headers, '大項目');
  var methodCol = findCol_(headers, '支付方式');
  var payerCol = findCol_(headers, '付款人');
  return {
    categories: catCol > 0 ? getListValidationValues_(sheet, catCol) : [],
    methods: methodCol > 0 ? getListValidationValues_(sheet, methodCol) : [],
    people: payerCol > 0 ? getListValidationValues_(sheet, payerCol) : []
  };
}

function getListValidationValues_(sheet, col) {
  var rule = sheet.getRange(2, col).getDataValidation();
  if (!rule) return [];
  var criteria = rule.getCriteriaType();
  var values = rule.getCriteriaValues();
  if (criteria == SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) return values[0];
  if (criteria == SpreadsheetApp.DataValidationCriteria.VALUE_IN_RANGE) {
    return values[0].getValues().reduce(function (a, b) { return a.concat(b); }, []).filter(String);
  }
  return [];
}

function ensureBookkeepingColumns_(sheet) {
  if (!sheet.getRange(1, COL.MODIFIED).getValue()) sheet.getRange(1, COL.MODIFIED).setValue(HEADERS[COL.MODIFIED - 1]);
  if (!sheet.getRange(1, COL.LOCAL_ID).getValue()) sheet.getRange(1, COL.LOCAL_ID).setValue(HEADERS[COL.LOCAL_ID - 1]);
}

function findRowByLocalId_(sheet, localId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var ids = sheet.getRange(2, COL.LOCAL_ID, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === localId) return i + 2;
  }
  return null;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
