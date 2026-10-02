// ============================================================
//  SPENDO – Google Apps Script Backend  v3.0
//  Deploy as: Web App → Execute as: Me → Who has access: Anyone
//
//  ALL actions use GET (e.parameter) — reliable cross-origin.
//
//  v3.0 changes (Saving module)
//  ─ New "Saving" sheet for saving transactions
//  ─ addSavingTransaction(): add saving entry
//  ─ getSavingSummary(): total saved, spent from saving, remaining
//  ─ getSavingTransactions(): list saving transactions
//  ─ Salary→Saving overflow: when salary balance exhausted, expense
//    deducted from saving and logged in both sheets
// ============================================================

const SHEET_LOGIN  = "Login";
const SHEET_SAVING = "Saving";
const SHEET_FINANCE = "Finance";   // v4.0 — Finance tab (single storage sheet)
const SHEET_CHIT    = "ChitFunds"; // v4.1 — Finance → Chit Funds
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// ─────────────────────────────────────────────────────────────
//  Cell alignment (v4.3) — every data row in every sheet:
//  numbers and dates centred, text left, empty cells untouched.
// ─────────────────────────────────────────────────────────────
function alignCell(v) {
  if (v === "" || v === null || v === undefined) return "normal";
  return typeof v === "number" || Object.prototype.toString.call(v) === "[object Date]" ? "center" : "left";
}

// Aligns `rows` (already written) starting at sheet row `startRow`
function alignRows(sheet, startRow, rows) {
  if (!rows || !rows.length) return;
  sheet.getRange(startRow, 1, rows.length, rows[0].length)
    .setHorizontalAlignments(rows.map(function(r) { return r.map(alignCell); }));
}

// One-time / repair: re-align the data rows of every sheet (run from the editor).
// Finance and ChitFunds align themselves on every save; Login is left alone.
function alignAllSheets() {
  SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach(function(sheet) {
    const name = sheet.getName();
    if (name === SHEET_LOGIN || name === SHEET_FINANCE || name === SHEET_CHIT) return;
    const last = sheet.getLastRow(), cols = sheet.getLastColumn();
    if (last < 2 || cols < 1) return;
    alignRows(sheet, 2, sheet.getRange(2, 1, last - 1, cols).getValues());
  });
}

// ─────────────────────────────────────────────────────────────
//  Entry points
// ─────────────────────────────────────────────────────────────

function doGet(e)  { return handleRequest(e); }
function doPost(e) { return handleRequest(e); }

function handleRequest(e) {
  const p      = e.parameter || {};
  const action = p.action    || "";

  try {
    if (action === "login") return respond(login(p));

    const auth = validateApiKey(p.apiKey || "");
    if (!auth.valid) return respond({ success: false, error: auth.error });

    switch (action) {
      case "getTransactions":   return respond(getTransactions(p));
      case "addTransaction":    return respond(addTransaction(p));
      case "updateTransaction": return respond(updateTransaction(p));
      case "deleteTransaction": return respond(deleteTransaction(p));
      case "getSummary":        return respond(getSummary(p));
      case "refreshReports":    return respond(refreshReports(p));   // v3.2
      case "refreshAllYears":   return respond(refreshAllYears());   // v3.3
      case "getMasterData":            return respond(getMasterData(p));            // v3.3
      case "migrateLegacyMonthSheets": return respond(migrateLegacyMonthSheets());   // v3.3
      case "cleanupLegacyMonthSheets": return respond(cleanupLegacyMonthSheets());   // v3.4
      case "getAdminReport":          return respond(getAdminReport(p));
      case "getMonthlySummaryReport": return respond(getMonthlySummaryReport(p)); // v2.6
      // v3.0 — Saving module
      case "addSavingTransaction":       return respond(addSavingTransaction(p));
      case "getSavingSummary":             return respond(getSavingSummary(p));
      case "getSavingTransactions":        return respond(getSavingTransactions(p));
      case "getAdminSavingReport":         return respond(getAdminSavingReport(p));
      case "recoverSavingFromSalary":      return respond(recoverSavingFromSalary(p));
      // v4.0 — Finance tab
      case "getFinance":          return respond(getFinance(p));
      case "addFinancePerson":    return respond(saveFinancePerson(p));
      case "updateFinancePerson": return respond(saveFinancePerson(p));
      case "deleteFinancePerson": return respond(deleteFinancePerson(p));
      case "saveFinanceMonth":    return respond(saveFinanceMonth(p));
      // v4.1 — Chit Funds
      case "getChits":            return respond(getChits(p));
      case "addChit":             return respond(saveChit(p));
      case "updateChit":          return respond(saveChit(p));
      case "deleteChit":          return respond(deleteChit(p));
      case "saveChitMonth":       return respond(saveChitMonth(p));
      default: return respond({ success: false, error: "Unknown action: " + action });
    }
  } catch (err) {
    return respond({ success: false, error: err.message });
  }
}

function respond(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─────────────────────────────────────────────────────────────
//  Auth
// ─────────────────────────────────────────────────────────────

function login(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let   sheet = ss.getSheetByName(SHEET_LOGIN);
  if (!sheet) sheet = createLoginSheet(ss);

  const data    = sheet.getDataRange().getValues();
  const headers = data[0];

  // Column indices — resolved dynamically so column order in sheet doesn't matter
  const uidIdx    = headers.indexOf("User_ID");
  const nameIdx   = headers.indexOf("Name");
  const pwIdx     = headers.indexOf("Password");
  const keyIdx    = headers.indexOf("API_Key");
  const expIdx    = headers.indexOf("Expire_Date");
  const urlIdx    = headers.indexOf("Script_URL");    // v2.9: optional URL validation column

  if (uidIdx < 0 || pwIdx < 0 || keyIdx < 0 || expIdx < 0) {
    return { success: false, error: "Login sheet columns missing. Re-run setupSpreadsheet()." };
  }

  const userId    = String(p.userId    || "").trim();
  const password  = String(p.password  || "").trim();
  const scriptUrl = String(p.scriptUrl || "").trim();  // v2.9: URL sent by client for validation

  for (let r = 1; r < data.length; r++) {
    if (String(data[r][uidIdx]).trim() !== userId)   continue;
    if (String(data[r][pwIdx]).trim()  !== password) continue;

    // v2.9: validate Script_URL if the column exists and the cell has a value
    if (urlIdx >= 0 && scriptUrl) {
      const sheetUrl = String(data[r][urlIdx] || "").trim();
      if (sheetUrl && sheetUrl !== scriptUrl) {
        return { success: false, error: "Invalid Script URL. Please contact your administrator." };
      }
    }

    // Credentials match — generate key with 30-min expiry
    const apiKey = generateKey();
    const expire = new Date(Date.now() + 30 * 60 * 1000);
    sheet.getRange(r + 1, keyIdx + 1).setValue(apiKey);
    sheet.getRange(r + 1, expIdx + 1).setValue(expire.toISOString());

    // Resolve display name: Name column value, fallback to User_ID
    const displayName = (nameIdx >= 0 && String(data[r][nameIdx]).trim())
      ? String(data[r][nameIdx]).trim()
      : userId;

    // isAdmin: true only for the built-in "admin" User_ID
    const isAdmin = (userId.toLowerCase() === "admin");

    return {
      success   : true,
      apiKey    : apiKey,
      expiresAt : expire.toISOString(),
      name      : displayName,
      isAdmin   : isAdmin
    };
  }
  return { success: false, error: "Invalid User ID or Password." };
}

function validateApiKey(apiKey) {
  if (!apiKey || apiKey === "undefined" || apiKey === "null") {
    return { valid: false, error: "No API key provided." };
  }

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_LOGIN);
  if (!sheet) return { valid: false, error: "Login sheet not found." };

  const data    = sheet.getDataRange().getValues();
  const headers = data[0];
  const keyIdx  = headers.indexOf("API_Key");
  const expIdx  = headers.indexOf("Expire_Date");

  for (let r = 1; r < data.length; r++) {
    if (String(data[r][keyIdx]).trim() !== String(apiKey).trim()) continue;
    const expireStr = data[r][expIdx];
    if (!expireStr) return { valid: false, error: "API key has no expiry date." };
    const expire = new Date(expireStr);
    if (isNaN(expire.getTime())) return { valid: false, error: "API key expiry date is invalid." };
    if (expire > new Date()) return { valid: true };
    return { valid: false, error: "Session expired. Please log in again." };
  }
  return { valid: false, error: "Invalid API key." };
}

function generateKey() {
  return Utilities.getUuid().replace(/-/g, "");
}

// ─────────────────────────────────────────────────────────────
//  Transaction sheets
//
//  Column layout (v2.2)  — 7 columns
//  0: ID  1: Date  2: Name  3: Type  4: Category  5: Amount  6: Description
//
//  v3.3: sheet tabs are year-scoped, e.g. "May26", "Jun26" — built from
//  monthSheetKey(). p.month from the client is always the bare month name
//  ("May"); p.year is optional and defaults to the current year, since the
//  client has no year selector yet. addTransaction always derives both
//  from the transaction's own date, so back-dated entries land correctly.
// ─────────────────────────────────────────────────────────────

function monthSheetKey(month, year) {
  return month + String(year).slice(-2);
}

function resolveYear(p) {
  return (p && p.year) ? parseInt(p.year, 10) : new Date().getFullYear();
}

// v3.5 — physical in-sheet "Over Usage" divider. Transactions run in
// CreatedAt order; once running balance would go negative, the expense
// that tips it is split into a covered portion (stays above the divider,
// uses up the last of the budget) + an excess portion (goes below the
// divider) — so the divider section total always exactly equals the
// month's real overuse deficit, matching Master_<year>. Both halves keep
// the original transaction's ID, so a merge pass reunites them into one
// row again before any lookup-by-ID (update/delete) or future rebuild.
// A later Income transaction pays down the oldest over-usage rows first
// (whole rows only, no further splitting) and those rows move back above
// the divider — the divider itself just naturally ends up further down.
const OVER_USAGE_DIVIDER_TEXT = "---------------- Over Usage Of Expenses ----------------";
const MONTH_SHEET_COLS = 8;

// Collapses rows that share an ID (i.e. a previously split transaction)
// back into one row, summing the Amount column. First-seen row supplies
// all other fields. Input/output are plain row arrays (no header).
function mergeDuplicateIdRows(rows) {
  const byId = {};
  const order = [];
  rows.forEach(function(row) {
    const id = String(row[0]);
    if (byId[id]) {
      byId[id][5] = (parseFloat(byId[id][5]) || 0) + (parseFloat(row[5]) || 0);
    } else {
      byId[id] = row.slice();
      order.push(id);
    }
  });
  return order.map(function(id) { return byId[id]; });
}

// Physically merges any split-transaction row pairs in the sheet back into
// single rows. Call this BEFORE searching the sheet by ID (update/delete),
// since a split transaction's two halves would otherwise look like a
// duplicate/partial match.
// Returns the merged, no-header row data (row 0 == sheet row 2) so callers
// that already need a fresh read (update/delete) can reuse it instead of
// issuing a second getDataRange() round trip.
function mergeSplitRowsInSheet(sheet) {
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const data   = sheet.getRange(2, 1, lastRow - 1, MONTH_SHEET_COLS).getValues();
  const merged = mergeDuplicateIdRows(data.filter(function(row) { return row[0]; }));

  sheet.getRange(2, 1, lastRow - 1, MONTH_SHEET_COLS).clearContent();
  if (merged.length) sheet.getRange(2, 1, merged.length, MONTH_SHEET_COLS).setValues(merged);
  alignRows(sheet, 2, merged);
  return merged;
}

// Stable sort by CreatedAt ascending — true add order, independent of
// whatever position a row currently sits at in the sheet.
function sortByCreatedAt(txRows) {
  return txRows
    .map(function(row, idx) { return { row: row, idx: idx }; })
    .sort(function(a, b) {
      let ta = a.row[7] ? new Date(a.row[7]).getTime() : NaN;
      let tb = b.row[7] ? new Date(b.row[7]).getTime() : NaN;
      if (isNaN(ta)) ta = a.idx;
      if (isNaN(tb)) tb = b.idx;
      return (ta - tb) || (a.idx - b.idx);
    })
    .map(function(x) { return x.row; });
}

// Single source of truth for the "Over Usage Of Expenses" split: walks
// CreatedAt-ordered rows with a running balance and returns { mainList,
// overList }. An expense that tips the balance negative is split into a
// covered portion (mainList) + excess portion (overList); a later Income
// pays back the oldest overList rows first (whole rows only). Used both to
// physically reorder the month sheet (rebuildMonthSheetOrder) and to
// compute the real overuse category breakdown for reports
// (computeMonthTotals) — so the two never disagree on which transactions
// count as overuse.
function partitionOverUsage(txRows) {
  const mainList = [];
  const overList = [];

  txRows.forEach(function(row) {
    const type   = String(row[3]).trim();
    const amount = parseFloat(row[5]) || 0;

    if (type === "Income") {
      let remaining = amount;
      while (overList.length && remaining > 0) {
        const front    = overList[0];
        const frontAmt = parseFloat(front[5]) || 0;
        if (frontAmt > remaining) break; // no splitting a transaction on the repay path
        remaining -= frontAmt;
        overList.shift();
        mainList.push(front);
      }
      mainList.push(row);
    } else {
      const balance = mainList.reduce(function(sum, r) {
        const t = String(r[3]).trim();
        const a = parseFloat(r[5]) || 0;
        return sum + (t === "Income" ? a : -a);
      }, 0);

      if (balance - amount >= 0) {
        mainList.push(row); // fits entirely within budget
      } else if (balance > 0) {
        // Splits exactly at the boundary: covered portion uses the last of
        // the budget, excess portion is the true overuse amount.
        const covered = row.slice(); covered[5] = balance;
        const excess  = row.slice(); excess[5]  = amount - balance;
        mainList.push(covered);
        overList.push(excess);
      } else {
        overList.push(row); // budget already exhausted — entire expense is overuse
      }
    }
  });

  return { mainList: mainList, overList: overList };
}

function rebuildMonthSheetOrder(sheet) {
  if (!sheet) return;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return; // header only, nothing to reorder

  const data = sheet.getRange(2, 1, lastRow - 1, MONTH_SHEET_COLS).getValues();
  let txRows = mergeDuplicateIdRows(data.filter(function(row) { return row[0]; })); // drop old divider/blank rows, reunite any split pairs

  if (!txRows.length) {
    sheet.getRange(2, 1, lastRow - 1, MONTH_SHEET_COLS).clearContent();
    return;
  }

  txRows = sortByCreatedAt(txRows);
  const partitioned = partitionOverUsage(txRows);
  const mainList = partitioned.mainList;
  const overList = partitioned.overList;

  let outRows = mainList.slice();
  let dividerRowNum = -1; // 1-based sheet row, set below if a divider is written
  if (overList.length) {
    const divider = new Array(MONTH_SHEET_COLS).fill("");
    divider[2] = OVER_USAGE_DIVIDER_TEXT; // Name column
    dividerRowNum = mainList.length + 2; // +2: header row + 1-based offset
    outRows = outRows.concat([divider], overList);
  }

  // .clear() (not clearContent()) so any stale highlight from a prior
  // rebuild doesn't linger on a row that's no longer the divider.
  sheet.getRange(2, 1, lastRow - 1, MONTH_SHEET_COLS).clear();
  sheet.getRange(2, 1, outRows.length, MONTH_SHEET_COLS).setValues(outRows);
  alignRows(sheet, 2, outRows);
  if (dividerRowNum > 0) {
    sheet.getRange(dividerRowNum, 1, 1, MONTH_SHEET_COLS)
      .setBackground("#f4cccc") // light red — visually flags overuse
      .setFontWeight("bold")
      .setFontColor("#990000");
  }
}

function getMonthSheet(ss, month, create) {
  let sheet = ss.getSheetByName(month);
  if (!sheet && create) {
    sheet = ss.insertSheet(month);
    // v2.6: 8-column header — CreatedAt added at position 8
    sheet.appendRow(["ID", "Date", "Name", "Type", "Category", "Amount", "Description", "CreatedAt"]);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 110);
    sheet.setColumnWidth(2, 100);
    sheet.setColumnWidth(3, 120);
    sheet.setColumnWidth(4,  80);
    sheet.setColumnWidth(5, 140);
    sheet.setColumnWidth(6,  90);
    sheet.setColumnWidth(7, 200);
    sheet.setColumnWidth(8, 180);
  }
  return sheet;
}

function getTransactions(p) {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const month    = p.month    || getCurrentMonth();
  const year     = resolveYear(p);
  // userName filter: empty string means "show all" (admin); any other value = filter by name
  const userFilter = String(p.userName || "").trim();
  const sheet    = ss.getSheetByName(monthSheetKey(month, year)); // read-only — viewing a month must never create its sheet
  const data     = sheet ? sheet.getDataRange().getValues() : [];
  const rows     = [];
  for (let r = 1; r < data.length; r++) {
    if (!data[r][0]) continue;
    // v2.3 user filter — col 2 is Name
    if (userFilter && String(data[r][2]).trim() !== userFilter) continue;
    rows.push(rowToObj(data[r]));
  }
  return { success: true, transactions: rows, month: month };
}

function addTransaction(p) {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  // FIX: parse the incoming date string and store as formatted YYYY-MM-DD.
  // Using Utilities.formatDate prevents GAS from storing a Date object,
  // which would serialise differently in rowToObj and break Today filter.
  var rawDate    = String(p.date || "").trim();
  var dateObj    = rawDate ? new Date(rawDate) : new Date();
  var tz         = Session.getScriptTimeZone();
  var dateStr    = !isNaN(dateObj.getTime())
    ? Utilities.formatDate(dateObj, tz, "yyyy-MM-dd")
    : Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");

  var month      = MONTHS[!isNaN(dateObj.getTime()) ? dateObj.getMonth() : new Date().getMonth()];
  var txYear     = !isNaN(dateObj.getTime()) ? dateObj.getFullYear() : new Date().getFullYear();
  var sheet      = getMonthSheet(ss, monthSheetKey(month, txYear), true);
  var id         = Utilities.getUuid().substring(0, 8);
  var amount     = parseFloat(p.amount) || 0;

  // 8-column row
  sheet.appendRow([
    id,
    dateStr,                     // always "YYYY-MM-DD" string — never a Date object
    p.userName    || "",
    p.type        || "Expense",
    p.category    || "Other",
    amount,
    p.description || "",
    new Date().toISOString()     // CreatedAt — used for 24-hr edit/delete lock
  ]);

  rebuildMonthSheetOrder(sheet); // v3.5 — re-partition around the Over Usage divider
  refreshReports({ year: txYear, month: month }); // v3.3 — keep that year's Master/OverExpense in sync; v3.7 — month scopes the recompute to just this month
  return { success: true, id: id, month: month };
}

function updateTransaction(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const month = p.month || getCurrentMonth();
  const year  = resolveYear(p);
  const sheetKey = monthSheetKey(month, year);
  const sheet = ss.getSheetByName(sheetKey);
  if (!sheet) return { success: false, error: "Month sheet '" + sheetKey + "' not found." };

  // v3.7 — reuse merge's own read instead of a second getDataRange() call
  const data = mergeSplitRowsInSheet(sheet); // v3.5 — reunite any split transaction halves before searching by ID; no header, row 0 == sheet row 2
  for (let r = 0; r < data.length; r++) {
    if (String(data[r][0]) !== String(p.id)) continue;

    // Preserve existing Name if caller doesn't supply one
    const nameVal = (p.userName && p.userName.trim())
      ? p.userName.trim()
      : String(data[r][2] || "");

    // Preserve existing CreatedAt — never overwrite on edit
    const createdAt = data[r][7] ? String(data[r][7]) : new Date().toISOString();

    // v3.3: track old vs new year — if the edit moves the date across a
    // year boundary, both years' Master/OverExpense need refreshing.
    const oldYear    = rowYear(data[r]);
    const finalDate  = p.date || data[r][1];
    const finalDateObj = finalDate ? new Date(finalDate) : new Date();
    const newYear    = !isNaN(finalDateObj.getTime()) ? finalDateObj.getFullYear() : oldYear;

    // 8-column update
    sheet.getRange(r + 2, 1, 1, 8).setValues([[
      p.id,
      p.date        || data[r][1],
      nameVal,
      p.type        || data[r][3],
      p.category    || data[r][4],
      parseFloat(p.amount) || 0,
      p.description !== undefined ? p.description : data[r][6],
      createdAt
    ]]);
    rebuildMonthSheetOrder(sheet); // v3.5 — re-partition around the Over Usage divider
    refreshReports({ year: newYear, month: month }); // v3.3 — keep that year's Master/OverExpense in sync; v3.7 — month scopes the recompute to just this month
    if (oldYear && oldYear !== newYear) refreshReports({ year: oldYear, month: month });
    return { success: true };
  }
  return { success: false, error: "Transaction ID '" + p.id + "' not found in " + sheetKey + "." };
}

function deleteTransaction(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const month = p.month || getCurrentMonth();
  const year  = resolveYear(p);
  const sheetKey = monthSheetKey(month, year);
  const sheet = ss.getSheetByName(sheetKey);
  if (!sheet) return { success: false, error: "Month sheet '" + sheetKey + "' not found." };

  // v3.7 — reuse merge's own read instead of a second getDataRange() call
  const data = mergeSplitRowsInSheet(sheet); // v3.5 — reunite any split transaction halves before searching by ID; no header, row 0 == sheet row 2
  for (let r = 0; r < data.length; r++) {
    if (String(data[r][0]) === String(p.id)) {
      const delYear = rowYear(data[r]) || new Date().getFullYear();
      sheet.deleteRow(r + 2);
      rebuildMonthSheetOrder(sheet); // v3.5 — re-partition around the Over Usage divider
      refreshReports({ year: delYear, month: month }); // v3.3 — keep that year's Master/OverExpense in sync; v3.7 — month scopes the recompute to just this month
      return { success: true };
    }
  }
  return { success: false, error: "Transaction ID '" + p.id + "' not found." };
}

function getSummary(p) {
  const ss         = SpreadsheetApp.getActiveSpreadsheet();
  const month      = p.month || getCurrentMonth();
  const year       = resolveYear(p);
  const userFilter = String(p.userName || "").trim();

  // ── Current month ───────────────────────────────────────────
  const sheet = ss.getSheetByName(monthSheetKey(month, year)); // read-only — viewing a month must never create its sheet
  const data  = sheet ? sheet.getDataRange().getValues() : [];

  let income = 0, expense = 0;
  const catMap = {};

  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    if (!row[0]) continue;
    if (userFilter && String(row[2]).trim() !== userFilter) continue;
    const type   = String(row[3]).trim();
    const cat    = String(row[4]).trim();
    const amount = parseFloat(row[5]) || 0;
    if (type === "Income")  income  += amount;
    if (type === "Expense") expense += amount;
    if (type === "Expense") catMap[cat] = (catMap[cat] || 0) + amount;
  }

  // ── Cumulative carried balance (ALL months before current) ──
  // Walk Jan → month-before-current, sum each month's net,
  // skip months with no sheet or no data.
  // Business rule (v3.2): full monthly balance carries forward, including
  // deficits — an overspend month reduces the following month's opening
  // balance instead of being absorbed silently.
  const curIdx           = MONTHS.indexOf(month);
  const monthlyBreakdown = [];   // [{month, balance, carried}] for popup
  let   carriedBalance   = 0;

  for (let i = 0; i < curIdx; i++) {
    const mName  = MONTHS[i];
    const mSheet = ss.getSheetByName(monthSheetKey(mName, year));
    if (!mSheet) continue;

    const mData = mSheet.getDataRange().getValues();
    let mInc = 0, mExp = 0, hasData = false;

    for (let r = 1; r < mData.length; r++) {
      const row = mData[r];
      if (!row[0]) continue;
      if (userFilter && String(row[2]).trim() !== userFilter) continue;
      const type   = String(row[3]).trim();
      const amount = parseFloat(row[5]) || 0;
      if (type === "Income")  { mInc += amount; hasData = true; }
      if (type === "Expense") { mExp += amount; hasData = true; }
    }

    if (hasData) {
      const mBal    = mInc - mExp;
      const carried = mBal; // v3.2: deficit carries too, no clamp
      carriedBalance += carried;
      monthlyBreakdown.push({ month: mName, balance: mBal, carried: carried });
    }
  }

  const currentBalance = income - expense;
  const netBalance     = carriedBalance + currentBalance;

  // ── Budget % (current month only) ──────────────────────────
  const topCategories = Object.entries(catMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(function(e) { return { name: e[0], amount: e[1] }; });

  const budget     = p.budget ? parseFloat(p.budget) : income;
  const budgetUsed = budget > 0
    ? Math.round((expense / budget) * 100)
    : (expense > 0 ? 100 : 0);

  return {
    success          : true,
    month            : month,
    income           : income,
    expense          : expense,
    balance          : currentBalance,
    carriedBalance   : carriedBalance,   // sum of ALL months before current
    monthlyBreakdown : monthlyBreakdown, // array for popup detail view
    netBalance       : netBalance,
    budgetUsed       : budgetUsed,
    topCategories    : topCategories
  };
}

// ─────────────────────────────────────────────────────────────
//  Admin Report  (v2.4)
//  Returns per-user income/expense/balance summary + full
//  transaction list for a given month.  Admin-only by convention
//  (API key is validated above; frontend restricts the button).
// ─────────────────────────────────────────────────────────────

function getAdminReport(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const month = p.month || getCurrentMonth();
  const year  = resolveYear(p);
  const sheet = ss.getSheetByName(monthSheetKey(month, year)); // read-only — viewing a month must never create its sheet
  const data  = sheet ? sheet.getDataRange().getValues() : [];

  // Map: name → { income, expense, transactions[] }
  const userMap = {};

  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    if (!row[0]) continue;
    const name   = String(row[2] || "Unknown").trim();
    const type   = String(row[3]).trim();
    const amount = parseFloat(row[5]) || 0;

    if (!userMap[name]) {
      userMap[name] = { name: name, income: 0, expense: 0, transactions: [] };
    }

    if (type === "Income")  userMap[name].income  += amount;
    if (type === "Expense") userMap[name].expense += amount;

    userMap[name].transactions.push(rowToObj(row));
  }

  // Sort transactions newest-first within each user
  const users = Object.values(userMap).map(function(u) {
    u.balance      = u.income - u.expense;
    u.transactions = u.transactions.sort(function(a, b) {
      return new Date(b.date) - new Date(a.date);
    });
    return u;
  });

  // Sort users alphabetically
  users.sort(function(a, b) { return a.name.localeCompare(b.name); });

  return { success: true, month: month, users: users };
}
// ─────────────────────────────────────────────────────────────
//  Monthly Summary Report  (v2.6 — admin only)
//  Consolidated all-users income, expense, balance + category
//  breakdown for the selected month.
// ─────────────────────────────────────────────────────────────

function getMonthlySummaryReport(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const month = p.month || getCurrentMonth();
  const year  = resolveYear(p);
  const sheet = ss.getSheetByName(monthSheetKey(month, year)); // read-only — viewing a month must never create its sheet
  const data  = sheet ? sheet.getDataRange().getValues() : [];

  let income = 0, expense = 0;
  // catUserMap: { catName: { total: num, users: { userName: num } } }
  const catUserMap = {};

  for (let r = 1; r < data.length; r++) {
    const row    = data[r];
    if (!row[0]) continue;
    const type   = String(row[3]).trim();
    const cat    = String(row[4]).trim();
    const amount = parseFloat(row[5]) || 0;
    const name   = String(row[2] || "Unknown").trim();

    if (type === "Income")  income  += amount;
    if (type === "Expense") {
      expense += amount;
      if (!catUserMap[cat]) catUserMap[cat] = { total: 0, users: {} };
      catUserMap[cat].total += amount;
      catUserMap[cat].users[name] = (catUserMap[cat].users[name] || 0) + amount;
    }
  }

  // Build categories array with per-user breakdown sorted by amount desc
  const categories = Object.entries(catUserMap)
    .map(function(entry) {
      const catName = entry[0];
      const data    = entry[1];
      const users   = Object.entries(data.users)
        .map(function(u) { return { name: u[0], amount: u[1] }; })
        .sort(function(a, b) { return b.amount - a.amount; });
      return { name: catName, amount: data.total, users: users };
    })
    .sort(function(a, b) { return b.amount - a.amount; });

  return {
    success    : true,
    month      : month,
    income     : income,
    expense    : expense,
    balance    : income - expense,
    categories : categories   // each item now includes users[] for drill-down
  };
}

// ─────────────────────────────────────────────────────────────
//  Master + OverExpense Reports  (v3.3 — one pair of sheets per year)
//  Auto-refreshed, for the transaction's own year, after every
//  add/update/delete transaction.
// ─────────────────────────────────────────────────────────────

const SHEET_MASTER_PREFIX      = "Master_";
const SHEET_OVEREXPENSE_PREFIX = "OverExpense_";

function masterSheetName(year)      { return SHEET_MASTER_PREFIX + year; }
function overExpenseSheetName(year) { return SHEET_OVEREXPENSE_PREFIX + year; }

// Year a transaction row belongs to, from its Date column (row[1])
function rowYear(row) {
  if (!row[1]) return null;
  if (Object.prototype.toString.call(row[1]) === "[object Date]") return row[1].getFullYear();
  const y = parseInt(String(row[1]).substring(0, 4), 10);
  return isNaN(y) ? null : y;
}

// Income/expense/category totals for one month, one year (reads the
// year-scoped sheet directly, e.g. "May26")
function computeMonthTotals(ss, month, year) {
  const sheet = ss.getSheetByName(monthSheetKey(month, year));
  let income = 0, expense = 0, hasData = false;
  const catMap = {};
  const overCatMap = {};
  if (!sheet) return { income: income, expense: expense, catMap: catMap, overCatMap: overCatMap, hasData: hasData };

  const data = sheet.getDataRange().getValues();
  const txRows = [];
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    if (!row[0]) continue; // skips the Over Usage divider row too — it has no id
    if (rowYear(row) !== year) continue; // defensive — sheet is already year-scoped
    hasData = true;
    const type   = String(row[3]).trim();
    const cat    = String(row[4]).trim();
    const amount = parseFloat(row[5]) || 0;
    if (type === "Income")  income += amount;
    if (type === "Expense") {
      expense += amount;
      catMap[cat] = (catMap[cat] || 0) + amount;
    }
    txRows.push(row);
  }

  // Real overuse category breakdown: reunite any split covered/excess
  // halves already sitting in the sheet, then re-run the exact same
  // CreatedAt-ordered partition the sheet's own divider uses, so
  // categoryBreakdown reflects the actual transactions that landed after
  // income ran out — not a proportional slice of every category.
  const overList = partitionOverUsage(sortByCreatedAt(mergeDuplicateIdRows(txRows))).overList;
  overList.forEach(function(row) {
    const cat    = String(row[4]).trim();
    const amount = parseFloat(row[5]) || 0;
    overCatMap[cat] = (overCatMap[cat] || 0) + amount;
  });

  return { income: income, expense: expense, catMap: catMap, overCatMap: overCatMap, hasData: hasData };
}

// Single source of truth for Master/OverExpense/getMasterData — walks
// Jan → uptoIdx (default Dec) of one year and returns per-month figures,
// including the cumulative carry-forward (deficit-inclusive) and cumulative
// overuse (This Month / Previous / Total) so all three consumers stay
// identical. getMasterData passes uptoIdx = the requested month's index so
// it doesn't pay for sheet reads on months after the one being viewed.
function buildYearReport(ss, year, uptoIdx) {
  const lastIdx = (uptoIdx === undefined || uptoIdx === null) ? MONTHS.length - 1 : uptoIdx;
  const rawTotals = [];
  for (let idx = 0; idx <= lastIdx; idx++) rawTotals.push(computeMonthTotals(ss, MONTHS[idx], year));
  return buildYearReportFromRaw(rawTotals, year, uptoIdx);
}

// v3.7 — same math as buildYearReport(), but takes already-fetched per-month
// totals instead of reading every month's sheet itself. Lets refreshReports()
// patch just the one changed month's totals and recompute the cumulative
// carry-forward/overuse chain in memory, instead of re-reading all 12 month
// sheets on every single transaction edit.
function buildYearReportFromRaw(rawTotals, year, uptoIdx) {
  let carried           = 0;
  let cumulativeOveruse = 0;
  const monthly = [];
  const lastIdx = (uptoIdx === undefined || uptoIdx === null) ? MONTHS.length - 1 : uptoIdx;

  for (let idx = 0; idx <= lastIdx; idx++) {
    const month = MONTHS[idx];
    const t       = rawTotals[idx] || { income: 0, expense: 0, catMap: {}, overCatMap: {}, hasData: false };
    const balance = t.income - t.expense;
    const excess  = balance > 0 ? balance : 0;
    const overuse = balance < 0 ? -balance : 0;
    carried += balance; // full carry, negative included

    const previousOveruse = cumulativeOveruse;
    let thisMonthOveruse = 0;
    let categoryBreakdown = [];

    if (overuse > 0) {
      thisMonthOveruse = overuse;
      cumulativeOveruse += overuse;

      // Real overuse categories only — the actual transactions that landed
      // after income ran out (t.overCatMap), not every category scaled down
      // by its share of the month's total spend.
      categoryBreakdown = Object.entries(t.overCatMap || {})
        .map(function(e) { return { name: e[0], amount: e[1] }; })
        .sort(function(a, b) { return b.amount - a.amount; });
    }

    monthly.push({
      month: month, year: year,
      income: t.income, expense: t.expense, balance: balance,
      excess: excess, overuse: overuse, carriedForward: carried,
      thisMonthOveruse: thisMonthOveruse,
      previousOveruse: previousOveruse,
      totalOveruse: cumulativeOveruse,
      categoryBreakdown: categoryBreakdown,
      catMap: t.catMap, // v3.6 — full month category totals, for Summary_<year>
      hasData: t.hasData // v3.7 — no transactions this month; Master_/Summary_ skip rendering it
    });
  }

  return monthly;
}

// Rebuilds Master_<year>: a divider row per month, followed by Income /
// Expense / Balance / Excess / Overuse / CarriedForward / This Month
// Overuse / Previous Overuse / Total Overuse as label:value rows.
// v3.6 — CacheService wrapper around buildYearReport(). Every mutation
// already recomputes the full year via refreshReports(); caching that
// result means getMasterData() (and any other reader) can reuse it
// instead of re-reading every month's sheet from scratch on every call.
function yearReportCacheKey(year) { return "yearReport_v2_" + year; }

function cacheYearReport(year, monthly) {
  try {
    CacheService.getScriptCache().put(yearReportCacheKey(year), JSON.stringify(monthly), 21600); // 6h, the max
  } catch (e) { /* payload too large for cache — callers still work, just uncached */ }
}

function getYearReportCached(ss, year, forceRecompute) {
  if (!forceRecompute) {
    try {
      const cached = CacheService.getScriptCache().get(yearReportCacheKey(year));
      if (cached) return JSON.parse(cached);
    } catch (e) { /* fall through to recompute */ }
  }
  const monthly = buildYearReport(ss, year);
  cacheYearReport(year, monthly);
  return monthly;
}

// v3.7 — per-month raw totals (income/expense/catMap/hasData), cached
// separately from the derived `monthly` report so a single-month edit can
// patch just its own entry instead of re-reading all 12 month sheets.
function rawTotalsCacheKey(year) { return "rawTotals_v2_" + year; }

function cacheRawTotals(year, rawTotals) {
  try {
    CacheService.getScriptCache().put(rawTotalsCacheKey(year), JSON.stringify(rawTotals), 21600); // 6h, the max
  } catch (e) { /* payload too large for cache — callers still work, just uncached */ }
}

function getRawTotalsCached(ss, year) {
  try {
    const cached = CacheService.getScriptCache().get(rawTotalsCacheKey(year));
    if (cached) return JSON.parse(cached);
  } catch (e) { /* fall through to recompute */ }
  const rawTotals = MONTHS.map(function(m) { return computeMonthTotals(ss, m, year); });
  cacheRawTotals(year, rawTotals);
  return rawTotals;
}

function refreshMasterSheet(ss, year, monthly) {
  let sheet = ss.getSheetByName(masterSheetName(year));
  if (!sheet) sheet = ss.insertSheet(masterSheetName(year));
  sheet.clear();
  sheet.appendRow(["Month / Field", "Amount"]);
  sheet.setFrozenRows(1);

  monthly = monthly || getYearReportCached(ss, year, true);
  const rows = [];
  const dividerRows = []; // sheet row numbers (1-based) holding a month divider
  monthly.forEach(function(m) {
    if (!m.hasData) return; // no transactions this month — skip, don't render an empty entry

    dividerRows.push(rows.length + 2); // +2: header row + 1-based offset
    rows.push(["-------- " + m.month + " --------", ""]);
    rows.push(["Income", m.income]);
    rows.push(["Expense", m.expense]);
    rows.push(["Balance", m.balance]);
    rows.push(["Excess", m.excess]);
    rows.push(["Overuse", m.overuse]);
    rows.push(["CarriedForward", m.carriedForward]);
    rows.push(["This Month Overuse", m.thisMonthOveruse]);
    rows.push(["Previous Overuse", m.previousOveruse]);
    rows.push(["Total Overuse", m.totalOveruse]);
    rows.push(["", ""]); // spacer between months
  });
  if (rows.length) sheet.getRange(2, 1, rows.length, 2).setValues(rows);
  alignRows(sheet, 2, rows);
  highlightDividerRows(sheet, dividerRows, "#c9daf8"); // v3.6 — month divider highlight (light blue)

  sheet.setColumnWidth(1, 220);
  sheet.setColumnWidth(2, 130);
}

// Rebuilds OverExpense_<year>: a divider row per month where expense >
// income. Category amounts shown are the real transactions that landed
// after income ran out (see partitionOverUsage/computeMonthTotals's
// overCatMap) — not the month's full category spend, and not a
// proportional slice of every category.
function refreshOverExpenseSheet(ss, year, monthly) {
  let sheet = ss.getSheetByName(overExpenseSheetName(year));
  if (!sheet) sheet = ss.insertSheet(overExpenseSheetName(year));
  sheet.clear();
  sheet.appendRow(["Month / Category", "Amount"]);
  sheet.setFrozenRows(1);

  monthly = monthly || getYearReportCached(ss, year, true);
  const rows = [];
  const dividerRows = []; // sheet row numbers (1-based) holding a month divider
  monthly.forEach(function(m) {
    if (m.thisMonthOveruse <= 0) return; // month within income — nothing to log

    dividerRows.push(rows.length + 2); // +2: header row + 1-based offset
    rows.push(["-------- " + m.month + " --------", ""]);
    m.categoryBreakdown.forEach(function(c) { rows.push([c.name, c.amount]); });
    rows.push(["This Month Overuse", m.thisMonthOveruse]);
    rows.push(["Previous Overuse", m.previousOveruse]);
    rows.push(["Total Overuse", m.totalOveruse]);
    rows.push(["", ""]); // spacer between months
  });

  if (rows.length) sheet.getRange(2, 1, rows.length, 2).setValues(rows);
  alignRows(sheet, 2, rows);
  highlightDividerRows(sheet, dividerRows, "#f4cccc"); // v3.6 — month divider highlight (light red, overuse context)
  sheet.setColumnWidth(1, 220);
  sheet.setColumnWidth(2, 130);
}

const SHEET_SUMMARY_PREFIX = "Summary_";
function summarySheetName(year) { return SHEET_SUMMARY_PREFIX + year; }

// Rebuilds Summary_<year>: every month (regardless of overuse), a divider
// row, then Income / Expense totals, then that month's FULL category
// breakdown (not scaled to just the excess portion, unlike OverExpense_).
function refreshSummarySheet(ss, year, monthly) {
  let sheet = ss.getSheetByName(summarySheetName(year));
  if (!sheet) sheet = ss.insertSheet(summarySheetName(year));
  sheet.clear();
  sheet.appendRow(["Month / Category", "Amount"]);
  sheet.setFrozenRows(1);

  monthly = monthly || getYearReportCached(ss, year, true);
  const rows = [];
  const dividerRows = []; // sheet row numbers (1-based) holding a month divider

  monthly.forEach(function(m) {
    if (!m.hasData) return; // no transactions this month — skip, don't render an empty entry

    dividerRows.push(rows.length + 2); // +2: header row + 1-based offset
    rows.push(["-------- " + m.month + " --------", ""]);
    rows.push(["Income", m.income]);
    rows.push(["Expense", m.expense]);

    const catMap = m.catMap || {};
    Object.entries(catMap)
      .sort(function(a, b) { return b[1] - a[1]; })
      .forEach(function(e) { rows.push([e[0], e[1]]); });

    rows.push(["", ""]); // spacer between months
  });

  if (rows.length) sheet.getRange(2, 1, rows.length, 2).setValues(rows);
  alignRows(sheet, 2, rows);
  highlightDividerRows(sheet, dividerRows, "#c9daf8"); // v3.6 — month divider highlight (light blue, same as Master_)
  sheet.setColumnWidth(1, 220);
  sheet.setColumnWidth(2, 130);
}

// v3.6 — bolds + colors the background of given 1-based row numbers across
// columns A:B, used to make divider rows (month headers, Over Usage marker)
// stand out visually in Master/OverExpense/monthly sheets.
function highlightDividerRows(sheet, rowNumbers, bgColor) {
  rowNumbers.forEach(function(rowNum) {
    sheet.getRange(rowNum, 1, 1, 2)
      .setBackground(bgColor)
      .setFontWeight("bold");
  });
}

// Manual trigger action ("refreshReports", optional p.year) + called
// automatically after every transaction mutation, scoped to that
// transaction's own year, so Master_<year>/OverExpense_<year>/Summary_<year>
// stay in sync.
// v3.7 — perf: when p.month is given (every add/update/delete call passes
// it), only that one month's sheet gets re-read; the other 11 months' totals
// come from cache and the cumulative carry-forward/overuse chain is
// recomputed in memory. Cuts a single-transaction edit from 12 month-sheet
// reads down to 1. p.month omitted (maintenance/backfill callers) still does
// the full 12-sheet rebuild.
function refreshReports(p) {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const year = resolveYear(p);
  let rawTotals;

  if (p && p.month) {
    rawTotals = getRawTotalsCached(ss, year);
    const idx = MONTHS.indexOf(p.month);
    if (idx >= 0) rawTotals[idx] = computeMonthTotals(ss, p.month, year); // re-read only the changed month
  } else {
    rawTotals = MONTHS.map(function(m) { return computeMonthTotals(ss, m, year); }); // no month scope given — full recompute
  }
  cacheRawTotals(year, rawTotals); // keep raw-totals cache consistent for the next month-scoped call

  const monthly = buildYearReportFromRaw(rawTotals, year);
  cacheYearReport(year, monthly);

  refreshMasterSheet(ss, year, monthly);
  refreshOverExpenseSheet(ss, year, monthly);
  refreshSummarySheet(ss, year, monthly);
  return { success: true, year: year };
}

// v3.3 — available to ALL logged-in users (not admin-gated): returns the
// Master card + OverExpense card data for one month, for the "Master Data"
// report screen. p.month bare name (e.g. "May"), p.year optional (default
// current year). v3.6: reuses the cache refreshReports() already populated
// on the last transaction mutation instead of re-reading every month's
// sheet — a cache miss (e.g. after a script edit clears it) still works,
// just recomputes the full year once and re-caches it.
function getMasterData(p) {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const month   = p.month || getCurrentMonth();
  const year    = resolveYear(p);
  const monthly = getYearReportCached(ss, year, false);
  const entry   = monthly.filter(function(m) { return m.month === month; })[0];
  if (!entry) return { success: false, error: "Month '" + month + "' not found." };
  return Object.assign({ success: true }, entry);
}

// Scans every sheet whose name matches a month-key pattern (e.g. "May26")
// to discover which years already have data, then rebuilds
// Master_<year>/OverExpense_<year> for each one found. Run once from the
// Apps Script editor (or setupSpreadsheet) to backfill reports.
function refreshAllYears() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const years = {};
  const keyPattern = new RegExp("^(" + MONTHS.join("|") + ")(\\d{2})$");

  ss.getSheets().forEach(function(sh) {
    const match = keyPattern.exec(sh.getName());
    if (!match) return;
    years[2000 + parseInt(match[2], 10)] = true;
  });

  years[new Date().getFullYear()] = true; // always ensure current year exists

  Object.keys(years).forEach(function(year) {
    refreshReports({ year: parseInt(year, 10) }); // no month — full recompute; also refreshes raw-totals cache
  });

  return { success: true, years: Object.keys(years).map(Number) };
}

// v3.5 — retro-apply the Over Usage divider/reorder to month sheets that
// already had transactions before this feature existed. Safe to re-run;
// rebuildMonthSheetOrder() always recomputes from scratch off CreatedAt.
// Run once from the Apps Script editor after deploying v3.5.
function rebuildAllMonthSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const keyPattern = new RegExp("^(" + MONTHS.join("|") + ")(\\d{2})$");
  const done = [];

  ss.getSheets().forEach(function(sh) {
    if (!keyPattern.test(sh.getName())) return;
    rebuildMonthSheetOrder(sh);
    done.push(sh.getName());
  });

  refreshAllYears(); // Master/OverExpense reports depend on the same totals, keep in sync
  return { success: true, rebuilt: done };
}

// v3.3 — one-time, additive-only migration: copies rows from legacy bare
// month sheets ("Jan", "Feb", ... from before year-scoped sheet names) into
// the correct year-keyed sheet ("Jan26", ...), inferring each row's year
// from its own Date column. Legacy sheets are left completely untouched —
// nothing is deleted or renamed — so existing data can never be lost; this
// only makes it visible to the new year-scoped reports. Safe to re-run:
// rows already copied (matched by ID) are skipped.
function migrateLegacyMonthSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const results = [];

  MONTHS.forEach(function(month) {
    const legacy = ss.getSheetByName(month); // bare "Jan" etc.
    if (!legacy) return;

    const data = legacy.getDataRange().getValues();
    let copied = 0;

    for (let r = 1; r < data.length; r++) {
      const row = data[r];
      if (!row[0]) continue;
      const year   = rowYear(row) || new Date().getFullYear();
      const target = getMonthSheet(ss, monthSheetKey(month, year), true);

      const existingRows = Math.max(target.getLastRow() - 1, 0);
      const existingIds  = existingRows
        ? target.getRange(2, 1, existingRows, 1).getValues().map(function(x) { return String(x[0]); })
        : [];
      if (existingIds.indexOf(String(row[0])) !== -1) continue; // already migrated

      target.appendRow(row);
      copied++;
    }

    if (copied > 0) results.push({ legacySheet: month, rowsCopied: copied });
  });

  refreshAllYears();
  return { success: true, migrated: results };
}

// v3.4 — verify-then-delete cleanup for legacy bare month sheets ("Jan",
// "Feb", ...). For each one: every row's ID must be found in its
// year-keyed sheet (e.g. "Jan26") before that legacy sheet is deleted.
// A sheet with even ONE unmatched row is left completely alone — run
// migrateLegacyMonthSheets() again first if that happens. Fully empty
// legacy sheets (header row only) are deleted immediately since there's
// nothing to lose.
function cleanupLegacyMonthSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const report = [];

  MONTHS.forEach(function(month) {
    const legacy = ss.getSheetByName(month); // bare "Jan" etc.
    if (!legacy) return;

    const data = legacy.getDataRange().getValues();
    const targetIdCache = {}; // year -> Set of IDs already present in "Jan26" etc.
    let checked   = 0;
    let allFound  = true;
    let missingId = null;

    for (let r = 1; r < data.length; r++) {
      const row = data[r];
      if (!row[0]) continue;
      checked++;

      const year = rowYear(row) || new Date().getFullYear();
      if (!targetIdCache[year]) {
        const target = ss.getSheetByName(monthSheetKey(month, year));
        const rows   = target ? Math.max(target.getLastRow() - 1, 0) : 0;
        const ids    = rows ? target.getRange(2, 1, rows, 1).getValues().map(function(x) { return String(x[0]); }) : [];
        targetIdCache[year] = ids;
      }

      if (targetIdCache[year].indexOf(String(row[0])) === -1) {
        allFound  = false;
        missingId = String(row[0]);
        break;
      }
    }

    if (checked === 0) {
      ss.deleteSheet(legacy);
      report.push({ sheet: month, action: "deleted", reason: "was empty" });
    } else if (allFound) {
      ss.deleteSheet(legacy);
      report.push({ sheet: month, action: "deleted", reason: "all " + checked + " rows verified in year-keyed sheet(s)" });
    } else {
      report.push({ sheet: month, action: "kept", reason: "row ID " + missingId + " not found in target sheet — run migrateLegacyMonthSheets() first" });
    }
  });

  return { success: true, report: report };
}

function rowToObj(row) {
  // FIX: row[1] from Google Sheets can be a Date object, not a string.
  // Use Utilities.formatDate for reliable YYYY-MM-DD output.
  var dateStr = "";
  if (row[1]) {
    try {
      // If it's already a proper date object, format it
      if (Object.prototype.toString.call(row[1]) === "[object Date]") {
        dateStr = Utilities.formatDate(row[1], Session.getScriptTimeZone(), "yyyy-MM-dd");
      } else {
        // String — strip any time component
        dateStr = String(row[1]).split("T")[0].trim();
        // If it still looks like a JS date toString(), parse and reformat
        if (dateStr.length > 10) {
          var parsed = new Date(row[1]);
          if (!isNaN(parsed.getTime())) {
            dateStr = Utilities.formatDate(parsed, Session.getScriptTimeZone(), "yyyy-MM-dd");
          }
        }
      }
    } catch(e) {
      dateStr = String(row[1]).split("T")[0];
    }
  }

  return {
    id          : String(row[0]),
    date        : dateStr,
    name        : String(row[2] || ""),
    type        : String(row[3]),
    category    : String(row[4]),
    amount      : parseFloat(row[5]) || 0,
    description : String(row[6] || ""),
    createdAt   : row[7] ? String(row[7]) : ""
  };
}

function getCurrentMonth() {
  return MONTHS[new Date().getMonth()];
}

// ─────────────────────────────────────────────────────────────
//  Saving Module  (v3.0)
//
//  Saving Sheet column layout (10 columns):
//  0: ID  1: Date  2: UserName  3: Bank  4: TxType
//  5: Amount  6: Remark  7: AmountDeductedFromSaving
//  8: RemainingSavingBalance  9: CreatedAt
//
//  TxType values:
//    "Saving"   — user deposits into saving
//    "Expense"  — deduction from saving (overflow from salary)
// ─────────────────────────────────────────────────────────────

function getSavingSheet(ss) {
  let sheet = ss.getSheetByName(SHEET_SAVING);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_SAVING);
    sheet.appendRow([
      "ID", "Date", "UserName", "Bank", "TxType",
      "Amount", "Remark", "AmountDeductedFromSaving",
      "RemainingSavingBalance", "CreatedAt", "Category"
    ]);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1,  110); // ID
    sheet.setColumnWidth(2,  100); // Date
    sheet.setColumnWidth(3,  120); // UserName
    sheet.setColumnWidth(4,  120); // Bank
    sheet.setColumnWidth(5,   90); // TxType
    sheet.setColumnWidth(6,  100); // Amount
    sheet.setColumnWidth(7,  180); // Remark
    sheet.setColumnWidth(8,  200); // AmountDeductedFromSaving
    sheet.setColumnWidth(9,  200); // RemainingSavingBalance
    sheet.setColumnWidth(10, 180); // CreatedAt
    sheet.setColumnWidth(11, 140); // Category
  }
  return sheet;
}

function savingRowToObj(row) {
  var dateStr = "";
  if (row[1]) {
    try {
      if (Object.prototype.toString.call(row[1]) === "[object Date]") {
        dateStr = Utilities.formatDate(row[1], Session.getScriptTimeZone(), "yyyy-MM-dd");
      } else {
        dateStr = String(row[1]).split("T")[0].trim();
        if (dateStr.length > 10) {
          var parsed = new Date(row[1]);
          if (!isNaN(parsed.getTime())) {
            dateStr = Utilities.formatDate(parsed, Session.getScriptTimeZone(), "yyyy-MM-dd");
          }
        }
      }
    } catch(e) { dateStr = String(row[1]).split("T")[0]; }
  }
  return {
    id                      : String(row[0]),
    date                    : dateStr,
    userName                : String(row[2] || ""),
    bank                    : String(row[3] || ""),
    txType                  : String(row[4] || "Saving"),
    amount                  : parseFloat(row[5]) || 0,
    remark                  : String(row[6] || ""),
    amountDeductedFromSaving: parseFloat(row[7]) || 0,
    remainingSavingBalance  : parseFloat(row[8]) || 0,
    createdAt               : row[9] ? String(row[9]) : "",
    category                : String(row[10] || "")
  };
}

// Compute current saving balance for a user from the Saving sheet
// TxType "Recovery" restores saving balance (auto-recovered when salary income arrives)
function computeSavingBalance(ss, userName) {
  const sheet = getSavingSheet(ss);
  const data  = sheet.getDataRange().getValues();
  let total   = 0;
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    if (!row[0]) continue;
    const rowUser = String(row[2] || "").trim();
    if (rowUser !== userName) continue;
    const txType = String(row[4] || "").trim();
    const amount = parseFloat(row[5]) || 0;
    const deducted = parseFloat(row[7]) || 0;
    if (txType === "Saving") {
      total += amount;
    } else if (txType === "Expense") {
      total -= deducted;
    } else if (txType === "Recovery") {
      total += amount;   // Salary recovery restores saving balance
    }
  }
  return total;
}

// ─────────────────────────────────────────────────────────────
//  Salary → Saving Recovery  (v3.1 fix)
//
//  When salary income is added after saving was used to cover
//  overflow expenses, this function auto-recovers (restores) the
//  saving deductions up to the new salary income amount.
//
//  Logic:
//    unrecovered = Σ Expense.deducted − Σ Recovery.amount
//    recoveryAmount = min(salaryIncome, unrecovered)
//    → Append a "Recovery" row to the Saving sheet for recoveryAmount
// ─────────────────────────────────────────────────────────────
function recoverSavingFromSalary(p) {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const sheet    = getSavingSheet(ss);
  const data     = sheet.getDataRange().getValues();
  const userName = String(p.userName || "").trim();
  const salaryIncome = parseFloat(p.amount) || 0;

  if (salaryIncome <= 0) return { success: true, recovered: 0 };

  // Sum all unrecovered saving expenses
  var totalExpenses   = 0;
  var totalRecoveries = 0;
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    if (!row[0]) continue;
    if (String(row[2] || "").trim() !== userName) continue;
    var txType  = String(row[4] || "").trim();
    var deducted = parseFloat(row[7]) || 0;
    var amount   = parseFloat(row[5]) || 0;
    if (txType === "Expense")  totalExpenses   += deducted;
    if (txType === "Recovery") totalRecoveries += amount;
  }

  var unrecovered = Math.max(0, totalExpenses - totalRecoveries);
  if (unrecovered <= 0) return { success: true, recovered: 0 };

  var recoveryAmount = Math.min(salaryIncome, unrecovered);
  if (recoveryAmount <= 0) return { success: true, recovered: 0 };

  var tz      = Session.getScriptTimeZone();
  var dateStr = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  var id      = Utilities.getUuid().substring(0, 8);

  // Compute new saving balance after recovery
  var prevBalance = computeSavingBalance(ss, userName);
  var newBalance  = prevBalance + recoveryAmount;

  // Append Recovery row (same 11-column layout as other saving rows)
  const savingRow = [
    id,
    dateStr,
    userName,
    "—",                                      // Bank — not applicable
    "Recovery",                               // TxType
    recoveryAmount,                           // Amount (restored to saving)
    "Auto-recovered from salary income",      // Remark
    0,                                        // AmountDeductedFromSaving (none — this is a credit)
    newBalance,                               // RemainingSavingBalance
    new Date().toISOString(),                 // CreatedAt
    "Salary"                                  // Category
  ];
  sheet.appendRow(savingRow);
  alignRows(sheet, sheet.getLastRow(), [savingRow]);

  return {
    success           : true,
    recovered         : recoveryAmount,
    unrecoveredBefore : unrecovered,
    newSavingBalance  : newBalance
  };
}

// Add a saving deposit or record an expense deducted from saving
function addSavingTransaction(p) {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const sheet    = getSavingSheet(ss);
  const userName = String(p.userName || "").trim();

  var rawDate  = String(p.date || "").trim();
  var dateObj  = rawDate ? new Date(rawDate) : new Date();
  var tz       = Session.getScriptTimeZone();
  var dateStr  = !isNaN(dateObj.getTime())
    ? Utilities.formatDate(dateObj, tz, "yyyy-MM-dd")
    : Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");

  var id       = Utilities.getUuid().substring(0, 8);
  var amount   = parseFloat(p.amount) || 0;
  var txType   = String(p.txType || "Saving").trim(); // "Saving" or "Expense"
  var bank     = String(p.bank   || "").trim();
  var remark   = String(p.remark || "").trim();
  var category = String(p.category || "").trim();

  // Compute balance before this transaction
  var prevBalance = computeSavingBalance(ss, userName);
  var deducted    = 0;
  var newBalance  = prevBalance;

  if (txType === "Saving") {
    newBalance = prevBalance + amount;
    deducted   = 0;
  } else if (txType === "Expense") {
    deducted   = amount;
    newBalance = prevBalance - amount;
  }

  const savingRow = [
    id,
    dateStr,
    userName,
    bank,
    txType,
    amount,
    remark,
    deducted,
    newBalance,
    new Date().toISOString(),
    category
  ];
  sheet.appendRow(savingRow);
  alignRows(sheet, sheet.getLastRow(), [savingRow]);

  return { success: true, id: id, remainingSavingBalance: newBalance };
}

function getSavingSummary(p) {
  const ss          = SpreadsheetApp.getActiveSpreadsheet();
  const sheet       = getSavingSheet(ss);
  const data        = sheet.getDataRange().getValues();
  const userName    = String(p.userName || "").trim();
  const filterMonth = p.month ? String(p.month).trim() : null; // e.g. "May"
  const filterMonthIdx = filterMonth ? MONTHS.indexOf(filterMonth) : -1;

  var totalSaving   = 0;  // deposits in selected month only (Saving type)
  var totalSpent    = 0;  // gross deductions in selected month only
  var totalRecovery = 0;  // recoveries in selected month only
  var cumSaving     = 0;  // all-time Saving deposits up to and including selected month
  var cumSpent      = 0;  // all-time gross deductions
  var cumRecovery   = 0;  // all-time recoveries (tracked separately — NOT added to cumSaving)
  const catMap      = {}; // category → total expense deducted (month-only)

  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    if (!row[0]) continue;
    const rowUser = String(row[2] || "").trim();
    if (userName && rowUser !== userName) continue;

    // Parse date to determine which month this row belongs to
    var dateStr = "";
    if (row[1]) {
      try {
        if (Object.prototype.toString.call(row[1]) === "[object Date]") {
          dateStr = Utilities.formatDate(row[1], Session.getScriptTimeZone(), "yyyy-MM-dd");
        } else {
          dateStr = String(row[1]).split("T")[0].trim();
        }
      } catch(e) { dateStr = String(row[1]).split("T")[0]; }
    }
    const txDate     = dateStr ? new Date(dateStr) : null;
    const txMonthIdx = (txDate && !isNaN(txDate.getTime())) ? txDate.getMonth() : -1;

    const txType   = String(row[4] || "").trim();
    const amount   = parseFloat(row[5]) || 0;
    const deducted = parseFloat(row[7]) || 0;
    const category = String(row[10] || "Other").trim() || "Other";

    // Cumulative balance: count all rows up to and including filterMonth
    // Recovery is tracked separately — NOT added to cumSaving to avoid inflating Total Saved
    const inOrBefore = (filterMonthIdx < 0) || (txMonthIdx >= 0 && txMonthIdx <= filterMonthIdx);
    if (inOrBefore) {
      if (txType === "Saving")        cumSaving   += amount;
      else if (txType === "Expense")  cumSpent    += deducted;
      else if (txType === "Recovery") cumRecovery += amount;  // reduces effective deduction; NOT added to savings
    }

    // Month-specific totals: only rows in the exact selected month
    const inMonth = (filterMonthIdx < 0) || (txMonthIdx === filterMonthIdx);
    if (inMonth) {
      if (txType === "Saving") {
        totalSaving += amount;
      } else if (txType === "Expense") {
        totalSpent  += deducted;
        catMap[category] = (catMap[category] || 0) + deducted;
      } else if (txType === "Recovery") {
        totalRecovery += amount;  // month-specific recovery tracked separately
      }
    }
  }

  // Adjust category breakdown to reflect only UNRECOVERED amounts.
  // Recovery rows are not category-specific, so we apply a proportional
  // scale-down across all categories:
  //   scaleFactor = netMonthDeducted / grossMonthDeducted
  // If everything is recovered, all categories collapse to 0 and are hidden.
  var netMonthDeducted = Math.max(0, totalSpent - totalRecovery);
  var adjustedCatMap   = {};
  if (totalSpent > 0) {
    var scaleFactor = netMonthDeducted / totalSpent;
    Object.keys(catMap).forEach(function(cat) {
      var adjusted = Math.round(catMap[cat] * scaleFactor);
      if (adjusted > 0) adjustedCatMap[cat] = adjusted;
    });
  }

  // Build category breakdown array sorted by amount desc (net amounts only)
  const categoryBreakdown = Object.entries(adjustedCatMap)
    .map(function(e) { return { name: e[0], amount: e[1] }; })
    .sort(function(a, b) { return b.amount - a.amount; });

  // Net deducted = gross deductions − recoveries; remaining = savings − net deducted
  var netCumSpent = Math.max(0, cumSpent - cumRecovery);
  var remaining   = cumSaving - netCumSpent;

  return {
    success               : true,
    month                 : filterMonth,
    totalSavingAmount     : totalSaving,
    amountSpentFromSaving : Math.max(0, totalSpent - totalRecovery),  // net deducted this month
    recoveryAmount        : totalRecovery,   // month-specific recovery (shown separately on dashboard)
    remainingSavingBalance: remaining,
    categoryBreakdown     : categoryBreakdown
  };
}

function getAdminSavingReport(p) {
  const ss          = SpreadsheetApp.getActiveSpreadsheet();
  const sheet       = getSavingSheet(ss);
  const data        = sheet.getDataRange().getValues();
  const filterMonth = p.month ? String(p.month).trim() : null;
  const filterMonthIdx = filterMonth ? MONTHS.indexOf(filterMonth) : -1;

  // Map: userName → { totalSaving, totalSpent, remainingBalance, transactions[] }
  const userMap = {};
  const allTxs  = [];

  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    if (!row[0]) continue;
    const obj  = savingRowToObj(row);
    const name = obj.userName || "Unknown";

    // Month filter
    if (filterMonthIdx >= 0) {
      const txDate = obj.date ? new Date(obj.date) : null;
      if (!txDate || isNaN(txDate.getTime()) || txDate.getMonth() !== filterMonthIdx) continue;
    }

    if (!userMap[name]) {
      userMap[name] = { name: name, totalSaving: 0, totalSpent: 0, totalRecovery: 0, remainingBalance: 0, transactions: [] };
    }

    if (obj.txType === "Saving") {
      userMap[name].totalSaving += obj.amount;
    } else if (obj.txType === "Expense") {
      userMap[name].totalSpent += obj.amountDeductedFromSaving;
    } else if (obj.txType === "Recovery") {
      // Recovery reduces effective deduction — tracked separately, NOT added to totalSaving
      userMap[name].totalRecovery += obj.amount;
    }
    userMap[name].transactions.push(obj);
    allTxs.push(obj);
  }

  const users = Object.values(userMap).map(function(u) {
    u.remainingBalance = u.totalSaving - u.totalSpent + (u.totalRecovery || 0);
    u.transactions = u.transactions.sort(function(a, b) {
      return new Date(b.date) - new Date(a.date);
    });
    return u;
  });
  users.sort(function(a, b) { return a.name.localeCompare(b.name); });
  allTxs.sort(function(a, b) { return new Date(b.date) - new Date(a.date); });

  return { success: true, users: users, transactions: allTxs };
}

function getSavingTransactions(p) {
  const ss          = SpreadsheetApp.getActiveSpreadsheet();
  const sheet       = getSavingSheet(ss);
  const data        = sheet.getDataRange().getValues();
  const userName    = String(p.userName || "").trim();
  const filterMonth = p.month ? String(p.month).trim() : null;
  const filterMonthIdx = filterMonth ? MONTHS.indexOf(filterMonth) : -1;
  const rows        = [];

  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    if (!row[0]) continue;
    const rowUser = String(row[2] || "").trim();
    if (userName && rowUser !== userName) continue;

    // Month filter
    if (filterMonthIdx >= 0) {
      var dateStr = "";
      if (row[1]) {
        try {
          if (Object.prototype.toString.call(row[1]) === "[object Date]") {
            dateStr = Utilities.formatDate(row[1], Session.getScriptTimeZone(), "yyyy-MM-dd");
          } else {
            dateStr = String(row[1]).split("T")[0].trim();
          }
        } catch(e) { dateStr = String(row[1]).split("T")[0]; }
      }
      const txDate = dateStr ? new Date(dateStr) : null;
      if (!txDate || isNaN(txDate.getTime()) || txDate.getMonth() !== filterMonthIdx) continue;
    }

    rows.push(savingRowToObj(row));
  }

  // Newest first
  rows.sort(function(a, b) { return new Date(b.date) - new Date(a.date); });
  return { success: true, transactions: rows, month: filterMonth };
}

// ─────────────────────────────────────────────────────────────
//  Auto Maintenance  (v3.5 — time-driven trigger, 1st of every month)
//
//  Every 1st of month: ensures current year's Master_<year>/OverExpense_
//  <year>/Summary_<year> exist (so year-start = Jan 1 = also
//  month-start, one trigger covers both), then deletes any month-key
//  sheet ("Jan26" etc.) that has zero transaction rows. v3.8 — no longer
//  pre-creates the current month's own sheet; a month sheet is only ever
//  created by addTransaction() when a real transaction lands in it.
//
//  Run installTriggers() once from the Apps Script editor to activate.
// ─────────────────────────────────────────────────────────────

function monthlyAutoMaintenance() {
  const now   = new Date();
  const year  = now.getFullYear();

  refreshReports({ year: year });    // ensure this year's Master/OverExpense/Summary exist
  cleanupEmptyMonthSheets(null);     // no month sheet is pre-created any more — nothing to skip
}

// Deletes any month-key sheet (e.g. "Jan26") with zero transaction rows.
// skipKey is never touched, even if it's brand new and thus empty.
function cleanupEmptyMonthSheets(skipKey) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const keyPattern = new RegExp("^(" + MONTHS.join("|") + ")(\\d{2})$");

  ss.getSheets().forEach(function(sh) {
    const name = sh.getName();
    if (name === skipKey) return;
    if (!keyPattern.test(name)) return;

    const lastRow = sh.getLastRow();
    if (lastRow < 2) { ss.deleteSheet(sh); return; }

    const ids = sh.getRange(2, 1, lastRow - 1, 1).getValues();
    const hasTx = ids.some(function(r) { return r[0]; });
    if (!hasTx) ss.deleteSheet(sh);
  });
}

// v3.7 — installable onChange trigger: catches manual row deletions made
// directly in the Sheets UI (deleteTransaction() already syncs API-driven
// deletes; onEdit does NOT fire on row delete, onChange does via
// e.changeType === "REMOVE_ROW"). Refreshes Master_<year>/OverExpense_<year>/
// Summary_<year> for whichever year the active month sheet belongs to.
function onChangeSyncReports(e) {
  if (!e || e.changeType !== "REMOVE_ROW") return;

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();
  const match = new RegExp("^(" + MONTHS.join("|") + ")(\\d{2})$").exec(sheet.getName());
  if (!match) return; // deletion wasn't on a month sheet — nothing to sync

  refreshReports({ year: 2000 + parseInt(match[2], 10) });
}

// One-time installer — run manually from the Apps Script editor.
function installTriggers() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.getProjectTriggers().forEach(function(t) {
    const fn = t.getHandlerFunction();
    if (fn === "monthlyAutoMaintenance" || fn === "onChangeSyncReports") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("monthlyAutoMaintenance")
    .timeBased()
    .onMonthDay(1)
    .atHour(0)
    .create();
  ScriptApp.newTrigger("onChangeSyncReports")
    .forSpreadsheet(ss)
    .onChange()
    .create();
}

// ─────────────────────────────────────────────────────────────
//  One-time setup  (run from Apps Script editor)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
//  Finance tab  (v4.0) — money given at a monthly ROI
//
//  The "Finance" sheet is the only storage. One block per person:
//    Title    : Name                                   | H: ID  I: UserName
//    Details  : Hand Loan Date | date | Principal Amount | amt | Rate Of Interest % | roi
//    Summary  : Monthly Interest | x | Pending Interest | x | Pending Months | x
//    Header   : Month | Interest Amount | Received Interest | Collected Interest
//               | Pending Interest Amount | Transaction Mode | Remarks | H: (month key)
//    Months   : one row per month                      | H: yyyy-MM
//    (blank row between blocks)
//  Columns H:I are hidden. Blocks written before v4.3 have no Collected
//  Interest column (metadata in G:H); the parser reads both and the next
//  write upgrades them. The sheet is parsed on every request and fully
//  rewritten after every change; Summary/Pending cells are recomputed.
//
//  Interest per month = Principal × ROI / 100 (editable per month). The
//  first month falls due one month after the hand loan date. A "No" month
//  adds its interest to Pending, which carries forward. A "Yes" month
//  collects everything pending plus that month, so Pending resets to 0.
//  The next not-yet-due month is listed (upcoming) so it can be updated
//  early; it adds to Pending only once its due date has passed.
// ─────────────────────────────────────────────────────────────

const FIN_COLS = 9;   // A–G visible, H–I hidden metadata

function finDate(v) {
  const tz = Session.getScriptTimeZone();
  if (Object.prototype.toString.call(v) === "[object Date]") return Utilities.formatDate(v, tz, "yyyy-MM-dd");
  const s = String(v || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : Utilities.formatDate(d, tz, "yyyy-MM-dd");
}

// yyyy-MM cell may come back from Sheets as a Date
function finMonthKey(v) {
  if (Object.prototype.toString.call(v) === "[object Date]") return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM");
  return String(v || "").trim();
}

// Same day-of-month k months later, clamped (31 Jan + 1 → 28/29 Feb)
function finAddMonths(isoDate, k) {
  const p = isoDate.split("-").map(Number);
  const last = new Date(p[0], p[1] - 1 + k + 1, 0).getDate();
  return new Date(p[0], p[1] - 1 + k, Math.min(p[2], last));
}

function finSheetObj(ss) {
  return ss.getSheetByName(SHEET_FINANCE) || ss.insertSheet(SHEET_FINANCE);
}

// Parse the Finance sheet → { persons: [...], months: { "id|yyyy-MM": {...} } }
function parseFinance(ss) {
  const data    = finSheetObj(ss).getDataRange().getValues();
  const persons = [], months = {};
  let cur = null, inTable = false;

  for (let r = 0; r < data.length; r++) {
    const row = data[r];
    const a   = String(row[0] || "").trim();
    const next = data[r + 1] ? String(data[r + 1][0] || "").trim() : "";

    if (a && next === "Hand Loan Date") {             // title row
      const d = data[r + 1];
      // o = 1 when the block has the Collected Interest column (v4.3+)
      const o = data[r + 3] && String(data[r + 3][3] || "").trim() === "Collected Interest" ? 1 : 0;
      cur = {
        o       : o,
        id      : String(row[6 + o] || "").trim() || Utilities.getUuid().substring(0, 8),
        userName: String(row[7 + o] || "").trim(),
        name    : a,
        date    : finDate(d[1]),
        amount  : parseFloat(d[3]) || 0,
        roi     : parseFloat(d[5]) || 0
      };
      persons.push(cur);
      inTable = false;
      r++;                                            // skip details row
      continue;
    }
    if (!cur) continue;
    if (a === "Month") { inTable = true; continue; }
    if (!a) { inTable = false; continue; }
    if (!inTable) continue;

    const o   = cur.o;
    const key = finMonthKey(row[6 + o]);
    if (!/^\d{4}-\d{2}$/.test(key)) continue;
    const interest = row[1] === "" || row[1] === null ? null : (parseFloat(row[1]) || 0);
    months[cur.id + "|" + key] = {
      received   : /^yes/i.test(String(row[2] || "").trim()) ? "Yes" : "No",
      interest   : interest,
      transaction: String(row[4 + o] || ""),
      remarks    : String(row[5 + o] || "")
    };
  }
  return { persons: persons, months: months };
}

// Builds month rows, pending carry-forward and counts for each person
function computeFinance(model) {
  const tz    = Session.getScriptTimeZone();
  const today = new Date(Utilities.formatDate(new Date(), tz, "yyyy-MM-dd") + "T00:00:00");

  model.persons.forEach(function(pr) {
    pr.interest = Math.round(pr.amount * pr.roi) / 100;
    pr.rows = [];
    pr.nextDue = "";
    let pending = 0;
    for (let k = 1; /^\d{4}-\d{2}-\d{2}$/.test(pr.date) && k <= 600; k++) {
      const due      = finAddMonths(pr.date, k);
      const upcoming = due > today;
      if (upcoming) pr.nextDue = Utilities.formatDate(due, tz, "yyyy-MM-dd");
      const key = Utilities.formatDate(due, tz, "yyyy-MM");
      const m   = model.months[pr.id + "|" + key] || { received: "No", transaction: "", remarks: "", interest: null };
      const interest = m.interest === null ? pr.interest : m.interest;
      let collected = 0;
      if (m.received === "Yes") { collected = pending + interest; pending = 0; }
      else if (!upcoming) pending += interest;
      pr.rows.push({ month: key, label: Utilities.formatDate(due, tz, "MMM yyyy"),
                     dueDate: Utilities.formatDate(due, tz, "yyyy-MM-dd"), interest: interest,
                     received: m.received, collected: collected, pending: pending, upcoming: upcoming,
                     transaction: m.transaction, remarks: m.remarks });
      if (upcoming) break;
    }
    pr.pending = pending;
    // Unpaid due months since the last "Yes" (a Yes clears everything before it)
    pr.pendingMonths = 0;
    pr.rows.forEach(function(r) {
      if (r.received === "Yes") pr.pendingMonths = 0;
      else if (!r.upcoming) pr.pendingMonths++;
    });
  });
  return model.persons;
}

// Month (data) rows: numbers centred, text left-aligned; other rows untouched.
// Returns one alignment per cell so a single setHorizontalAlignments() call does it.
function dataAlignments(out, dataRows, visibleCols) {
  return out.map(function(row, i) {
    return row.map(function(v, c) {
      return dataRows[i] && c < visibleCols ? alignCell(v) : "normal";
    });
  });
}

function writeFinance(ss, model) {
  const sheet   = finSheetObj(ss);
  const persons = computeFinance(model);
  const out = [], titles = [], infos = [], heads = [], data = {};
  const pad = function(a) { while (a.length < FIN_COLS) a.push(""); return a; };

  persons.forEach(function(pr) {
    titles.push(out.length + 1);
    out.push(pad([pr.name, "", "", "", "", "", "", pr.id, pr.userName]));
    infos.push(out.length + 1);
    out.push(pad(["Hand Loan Date", pr.date, "Principal Amount", pr.amount, "Rate Of Interest %", pr.roi]));
    infos.push(out.length + 1);
    out.push(pad(["Monthly Interest", pr.interest, "Pending Interest", pr.pending,
                  "Pending Months", pr.pendingMonths ? pr.pendingMonths : "No due"]));
    heads.push(out.length + 1);
    out.push(pad(["Month", "Interest Amount", "Received Interest", "Collected Interest", "Pending Interest Amount",
                  "Transaction Mode", "Remarks"]));
    pr.rows.forEach(function(r) {
      data[out.length] = true;
      out.push(pad([r.label, r.interest,
        r.received === "Yes" ? "Yes" : r.upcoming ? "Due " + r.dueDate : "No",
        r.received === "Yes" ? r.collected : "",
        r.upcoming && r.received !== "Yes" ? "" : r.pending, r.transaction, r.remarks, r.month]));
    });
    out.push(pad([]));
  });

  sheet.getDataRange().breakApart();   // merges from earlier versions
  sheet.clear();
  if (!out.length) return persons;

  // Month labels / keys must stay text — Sheets would turn "Oct 2026" into a date
  sheet.getRange(1, 1, out.length, 1).setNumberFormat("@");
  sheet.getRange(1, 8, out.length, 2).setNumberFormat("@");
  sheet.getRange(1, 1, out.length, FIN_COLS).setValues(out);

  // Batched formatting — a few calls total instead of several per person
  const rows = function(list) { return list.map(function(r) { return "A" + r + ":G" + r; }); };
  if (titles.length) sheet.getRangeList(rows(titles)).setFontWeight("bold").setFontSize(12)
    .setBackground("#1e7d55").setFontColor("#ffffff");
  if (infos.length) {
    sheet.getRangeList(rows(infos)).setBackground("#eef7f2");
    sheet.getRangeList([].concat.apply([], infos.map(function(r) { return ["A" + r, "C" + r, "E" + r]; })))
      .setFontWeight("bold");
  }
  if (heads.length) sheet.getRangeList(rows(heads)).setFontWeight("bold").setBackground("#d9d9d9");
  sheet.getRange(1, 1, out.length, FIN_COLS).setHorizontalAlignments(dataAlignments(out, data, 7));

  // Layout only needs setting once
  // First run, or a pre-v4.3 sheet where G was the hidden ID column
  if (!sheet.isColumnHiddenByUser(8) || sheet.isColumnHiddenByUser(7)) {
    sheet.showColumns(7);
    [130, 130, 140, 140, 170, 140, 220].forEach(function(w, i) { sheet.setColumnWidth(i + 1, w); });
    sheet.hideColumns(8, 2);
  }
  return persons;
}

// Read-modify-write under a script lock so two saves can't interleave.
// Returns the updated list (filtered by p.listUser) so the client needs
// no second getFinance round trip after a save.
function withFinance(p, fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const model = parseFinance(ss);
    const res   = fn(model);
    if (res.success) {
      const listUser = String(p.listUser || "").trim();
      res.persons = writeFinance(ss, model)
        .filter(function(pr) { return !listUser || pr.userName === listUser; });
    }
    return res;
  } finally {
    lock.releaseLock();
  }
}

function getFinance(p) {
  const userFilter = String(p.userName || "").trim();
  const persons = computeFinance(parseFinance(SpreadsheetApp.getActiveSpreadsheet()))
    .filter(function(pr) { return !userFilter || pr.userName === userFilter; });
  return { success: true, persons: persons };
}

function saveFinancePerson(p) {
  const name   = String(p.name || "").trim();
  const date   = finDate(p.date);
  const amount = parseFloat(p.amount) || 0;
  const roi    = parseFloat(p.roi) || 0;
  if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date) || amount <= 0) {
    return { success: false, error: "Person name, hand loan date and principal amount are required." };
  }
  return withFinance(p, function(model) {
    let id = String(p.id || "");
    if (id) {
      const pr = model.persons.find(function(x) { return x.id === id; });
      if (!pr) return { success: false, error: "Person not found." };
      // Months still on the old default amount follow the new principal/ROI
      const oldDefault = Math.round(pr.amount * pr.roi) / 100;
      Object.keys(model.months).forEach(function(k) {
        if (k.indexOf(id + "|") === 0 && model.months[k].interest === oldDefault) model.months[k].interest = null;
      });
      pr.name = name; pr.date = date; pr.amount = amount; pr.roi = roi;
    } else {
      id = Utilities.getUuid().substring(0, 8);
      model.persons.push({ id: id, userName: String(p.userName || "").trim(), name: name, date: date, amount: amount, roi: roi });
    }
    return { success: true, id: id };
  });
}

function deleteFinancePerson(p) {
  const id = String(p.id || "");
  return withFinance(p, function(model) {
    const before = model.persons.length;
    model.persons = model.persons.filter(function(x) { return x.id !== id; });
    if (model.persons.length === before) return { success: false, error: "Person not found." };
    return { success: true };
  });
}

function saveFinanceMonth(p) {
  const id    = String(p.personId || "");
  const month = String(p.month || "").trim();
  if (!id || !/^\d{4}-\d{2}$/.test(month)) return { success: false, error: "Person and month are required." };
  return withFinance(p, function(model) {
    if (!model.persons.some(function(x) { return x.id === id; })) return { success: false, error: "Person not found." };
    model.months[id + "|" + month] = {
      received   : p.received === "Yes" ? "Yes" : "No",
      interest   : p.interest === undefined || p.interest === "" ? null : (parseFloat(p.interest) || 0),
      transaction: String(p.transaction || "").trim(),
      remarks    : String(p.remarks || "").trim()
    };
    return { success: true };
  });
}

// ─────────────────────────────────────────────────────────────
//  Chit Funds  (v4.1)
//
//  The "ChitFunds" sheet is the only storage. One block per chit:
//    Title    : Name                                   | K: ID  L: UserName
//    Details  : Chitty Amount | amt | Start Date | date | Members | n
//    Summary  : Commission | comm | Monthly Due | amt/n | Remain Chits | x
//           or  Monthly Amount | inst | Holding Saving | x | Remain Chits | x
//               (the A label tells the chit type: "commission" | "saving")
//    Header   : Month | Date | Bid Amount | Comm Owner | By Hand
//               | Payable Amount | Remain Chits        | K: (month no.)
//           or  Month | Date | Bid Amount | By Hand | Payable Amount
//               | Bid Interest | Holding Saving | Remain Chits
//               | Interest On | Interest %
//    Months   : one row per month                      | K: 1..n
//               a 2nd chit gets its own row under it   | K: "k.2"
//    (blank row between blocks)
//  Columns K:L are hidden. Parsed on every request, fully rewritten on save.
//
//  Month k falls on start date + (k − 1) months. Entered per month: Bid
//  Amount, and for saving chits optionally Bid Interest and a 2nd Bid.
//  Commission type:
//    Comm Owner     = commission from the chit form (same every month)
//    By Hand        = Chitty Amount − Bid Amount
//    Payable Amount = (Chitty Amount − Bid Amount + Comm) / Members
//    Remain Chits   = Members − k
//  Saving type (no commission, everyone pays in full):
//    By Hand        = Chitty Amount − Bid Amount
//    Payable Amount = Monthly Amount from the chit form
//    Bid Interest   = Interest On × Interest % / 100 (Interest On defaults
//                     to the Holding carried from last month)
//    Holding Saving = last Holding + Bid Interest + Bid
//    2nd chit row (same month): By Hand = Chitty Amount − 2nd Bid, paid
//    out of Holding Saving; Remain Chits drops by one more, so the chit
//    can finish before Members months. Holding may go negative; if it is
//    still negative after the last month, that shortfall ÷ Members is added
//    to the last month's Payable Amount and Holding ends at 0.
// ─────────────────────────────────────────────────────────────

const CHIT_COLS = 12;   // A–J visible, K–L hidden metadata

function chitSheetObj(ss) {
  return ss.getSheetByName(SHEET_CHIT) || ss.insertSheet(SHEET_CHIT);
}

// Parse the ChitFunds sheet → { chits, bids, bids2, interest: {base, pct} } (maps keyed "id|k")
function parseChits(ss) {
  const data  = chitSheetObj(ss).getDataRange().getValues();
  const chits = [], bids = {}, bids2 = {}, interest = {};
  let cur = null, inTable = false;
  const blank = function(x) { return x === "" || x === null; };

  for (let r = 0; r < data.length; r++) {
    const row  = data[r];
    const a    = String(row[0] || "").trim();
    const next = data[r + 1] ? String(data[r + 1][0] || "").trim() : "";

    if (a && next === "Chitty Amount") {              // title row
      const d = data[r + 1], c = data[r + 2] || [];
      cur = {
        id        : String(row[10] || "").trim() || Utilities.getUuid().substring(0, 8),
        userName  : String(row[11] || "").trim(),
        name      : a,
        amount    : parseFloat(d[1]) || 0,
        date      : finDate(d[3]),
        members   : parseInt(d[5], 10) || 0,
        type      : String(c[0] || "").trim() === "Monthly Amount" ? "saving" : "commission",
        commission: 0,
        installment: 0
      };
      if (cur.type === "saving") cur.installment = parseFloat(c[1]) || 0;
      else cur.commission = parseFloat(c[1]) || 0;
      chits.push(cur);
      inTable = false;
      r += 2;                                         // skip details + summary
      continue;
    }
    if (!cur) continue;
    if (a === "Month") { inTable = true; continue; }
    if (!a) { inTable = false; continue; }
    if (!inTable) continue;

    const mk = String(row[10] || "").trim();
    const k  = parseInt(mk, 10);
    if (!k || blank(row[2])) continue;
    const key = cur.id + "|" + k;
    if (/\.2$/.test(mk)) { if (cur.type === "saving") bids2[key] = parseFloat(row[2]) || 0; continue; }
    bids[key] = parseFloat(row[2]) || 0;
    if (cur.type === "saving" && !blank(row[8]) && !blank(row[9]))
      interest[key] = { base: parseFloat(row[8]) || 0, pct: parseFloat(row[9]) || 0 };
  }
  return { chits: chits, bids: bids, bids2: bids2, interest: interest };
}

function computeChits(model) {
  const tz  = Session.getScriptTimeZone();
  const r2  = function(n) { return Math.round(n * 100) / 100; };
  const get = function(o, k) { return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null; };
  model.chits.forEach(function(ch) {
    const n = ch.members, saving = ch.type === "saving";
    ch.monthlyDue = n ? r2(ch.amount / n) : 0;
    ch.rows = [];
    ch.paid = 0;
    ch.holding = 0;
    ch.interest = 0;
    let remain = n, done = 0;
    for (let k = 1; /^\d{4}-\d{2}-\d{2}$/.test(ch.date) && remain > 0 && k <= 600; k++) {
      const due  = finAddMonths(ch.date, k - 1);
      const key  = ch.id + "|" + k;
      const bid  = get(model.bids, key);
      const bid2 = saving && bid !== null ? get(model.bids2, key) : null;
      const ib   = saving && bid !== null ? get(model.interest, key) : null;
      const int  = ib ? r2(ib.base * ib.pct / 100) : null;
      remain = Math.max(0, remain - 1);
      const date  = Utilities.formatDate(due, tz, "yyyy-MM-dd");
      const label = Utilities.formatDate(due, tz, "dd MMM yyyy");
      const row = { month: k, second: false, date: date, label: label,
                    bid: bid, comm: ch.commission, byHand: null, payable: null,
                    carried: ch.holding, interest: int, intBase: ib ? ib.base : null, intPct: ib ? ib.pct : null,
                    holding: null, bid2: bid2, remain: remain };
      if (bid !== null) {
        row.byHand  = r2(ch.amount - bid);
        row.payable = saving ? ch.installment : r2((ch.amount - bid + ch.commission) / n);
        if (saving) {
          ch.holding  = r2(ch.holding + (int || 0) + bid);
          ch.interest = r2(ch.interest + (int || 0));
          row.holding = ch.holding;
        }
        ch.paid += row.payable;
        done++;
      }
      ch.rows.push(row);
      if (bid2 !== null) {                            // 2nd chit, paid from Holding
        remain = Math.max(0, remain - 1);
        ch.holding = r2(ch.holding - (ch.amount - bid2));
        ch.rows.push({ month: k, second: true, date: date, label: label,
                       bid: bid2, comm: 0, byHand: r2(ch.amount - bid2), payable: null,
                       carried: null, interest: null, holding: ch.holding, bid2: null, remain: remain });
        done++;
      }
    }
    // Shortfall left once every chit is taken → recovered in the last Payable
    ch.shortfall = 0;
    const last = ch.rows.filter(function(r) { return !r.second; }).pop();
    if (saving && done >= n && ch.holding < 0 && last && last.payable !== null) {
      ch.shortfall = -ch.holding;
      last.shortfall = ch.shortfall;
      last.payable = r2(last.payable + ch.shortfall / n);
      ch.paid += ch.shortfall / n;
      ch.holding = 0;
      ch.rows[ch.rows.length - 1].holding = 0;
    }
    ch.paid   = r2(ch.paid);
    ch.remain = Math.max(0, n - done);
  });
  return model.chits;
}

function writeChits(ss, model) {
  const sheet = chitSheetObj(ss);
  const chits = computeChits(model);
  const out = [], titles = [], infos = [], heads = [], data = {};
  const pad = function(a) { while (a.length < CHIT_COLS) a.push(""); return a; };
  const v   = function(x) { return x === null ? "" : x; };

  chits.forEach(function(ch) {
    titles.push(out.length + 1);
    out.push(pad([ch.name, "", "", "", "", "", "", "", "", "", ch.id, ch.userName]));
    infos.push(out.length + 1);
    out.push(pad(["Chitty Amount", ch.amount, "Start Date", ch.date, "Members", ch.members]));
    infos.push(out.length + 1);
    const saving = ch.type === "saving";
    out.push(pad(saving
      ? ["Monthly Amount", ch.installment, "Holding Saving", ch.holding, "Remain Chits", ch.remain]
      : ["Commission", ch.commission, "Monthly Due", ch.monthlyDue, "Remain Chits", ch.remain]));
    heads.push(out.length + 1);
    out.push(pad(saving
      ? ["Month", "Date", "Bid Amount", "By Hand", "Payable Amount", "Bid Interest", "Holding Saving",
         "Remain Chits", "Interest On", "Interest %"]
      : ["Month", "Date", "Bid Amount", "Comm Owner", "By Hand", "Payable Amount", "Remain Chits"]));
    ch.rows.forEach(function(r) {
      data[out.length] = true;
      out.push(pad(saving
        ? [r.second ? r.month + " (2nd)" : r.month, r.label, v(r.bid), v(r.byHand), v(r.payable),
           v(r.interest), v(r.holding), r.remain, r.second ? "" : v(r.intBase), r.second ? "" : v(r.intPct),
           r.second ? r.month + ".2" : r.month]
        : [r.month, r.label, v(r.bid), r.comm, v(r.byHand), v(r.payable), r.remain, "", "", "", r.month]));
    });
    out.push(pad([]));
  });

  sheet.clear();
  if (!out.length) return chits;

  // Date labels / keys stay text — Sheets would reparse "05 Oct 2026"
  sheet.getRange(1, 2, out.length, 1).setNumberFormat("@");
  sheet.getRange(1, 11, out.length, 2).setNumberFormat("@");
  sheet.getRange(1, 1, out.length, CHIT_COLS).setValues(out);

  const rows = function(list) { return list.map(function(r) { return "A" + r + ":J" + r; }); };
  if (titles.length) sheet.getRangeList(rows(titles)).setFontWeight("bold").setFontSize(12)
    .setBackground("#1e7d55").setFontColor("#ffffff");
  if (infos.length) {
    sheet.getRangeList(rows(infos)).setBackground("#eef7f2");
    sheet.getRangeList([].concat.apply([], infos.map(function(r) { return ["A" + r, "C" + r, "E" + r]; })))
      .setFontWeight("bold");
  }
  if (heads.length) sheet.getRangeList(rows(heads)).setFontWeight("bold").setBackground("#d9d9d9");
  sheet.getRange(1, 1, out.length, CHIT_COLS).setHorizontalAlignments(dataAlignments(out, data, 10));

  if (!sheet.isColumnHiddenByUser(11)) {
    [90, 110, 110, 110, 120, 110, 120, 100, 110, 90].forEach(function(w, i) { sheet.setColumnWidth(i + 1, w); });
    sheet.hideColumns(11, 2);
  }
  return chits;
}

// Same lock + return-the-list pattern as withFinance
function withChits(p, fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const model = parseChits(ss);
    const res   = fn(model);
    if (res.success) {
      const listUser = String(p.listUser || "").trim();
      res.chits = writeChits(ss, model)
        .filter(function(ch) { return !listUser || ch.userName === listUser; });
    }
    return res;
  } finally {
    lock.releaseLock();
  }
}

function getChits(p) {
  const userFilter = String(p.userName || "").trim();
  const chits = computeChits(parseChits(SpreadsheetApp.getActiveSpreadsheet()))
    .filter(function(ch) { return !userFilter || ch.userName === userFilter; });
  return { success: true, chits: chits };
}

function saveChit(p) {
  const amount     = parseFloat(p.amount) || 0;
  const date       = finDate(p.date);
  const members    = parseInt(p.members, 10) || 0;
  const type       = p.type === "saving" ? "saving" : "commission";
  const commission = type === "saving" ? 0 : (parseFloat(p.commission) || 0);
  const installment = type === "saving" ? (parseFloat(p.installment) || 0) : 0;
  const name       = String(p.name || "").trim() || ("Chit " + amount);
  if (amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date) || members < 1 || commission < 0) {
    return { success: false, error: "Chitty amount, date and members are required." };
  }
  if (type === "saving" && installment <= 0) return { success: false, error: "Monthly amount is required." };
  return withChits(p, function(model) {
    let id = String(p.id || "");
    if (id) {
      const ch = model.chits.find(function(x) { return x.id === id; });
      if (!ch) return { success: false, error: "Chit not found." };
      ch.name = name; ch.amount = amount; ch.date = date; ch.members = members;
      ch.type = type; ch.commission = commission; ch.installment = installment;
    } else {
      id = Utilities.getUuid().substring(0, 8);
      model.chits.push({ id: id, userName: String(p.userName || "").trim(), name: name,
                         amount: amount, date: date, members: members, type: type,
                         commission: commission, installment: installment });
    }
    return { success: true, id: id };
  });
}

function deleteChit(p) {
  const id = String(p.id || "");
  return withChits(p, function(model) {
    const before = model.chits.length;
    model.chits = model.chits.filter(function(x) { return x.id !== id; });
    if (model.chits.length === before) return { success: false, error: "Chit not found." };
    return { success: true };
  });
}

// Empty bid clears that month (with its interest and 2nd bid). Saving
// chits may also record Bid Interest and a 2nd Bid; empty = none. A 2nd
// chit may take Holding below 0 (recovered in the last month's Payable).
function saveChitMonth(p) {
  const id = String(p.chitId || "");
  const k  = parseInt(p.month, 10);
  if (!id || !k) return { success: false, error: "Chit and month are required." };
  const num = function(x) { const t = String(x === undefined ? "" : x).trim(); return t === "" ? null : parseFloat(t); };
  return withChits(p, function(model) {
    const ch = model.chits.find(function(x) { return x.id === id; });
    if (!ch) return { success: false, error: "Chit not found." };
    if (k > ch.members) return { success: false, error: "Month is beyond the member count." };
    const key = id + "|" + k;
    const bid = num(p.bid), bid2 = num(p.bid2), base = num(p.intBase), pct = num(p.intPct);
    delete model.bids[key]; delete model.bids2[key]; delete model.interest[key];
    if (bid === null) return { success: true };
    const inRange = function(b) { return !isNaN(b) && b >= 0 && b <= ch.amount; };
    if (!inRange(bid)) return { success: false, error: "Bid must be between 0 and the chitty amount." };
    model.bids[key] = bid;
    if (ch.type === "saving") {
      if (bid2 !== null) {
        if (!inRange(bid2)) return { success: false, error: "2nd bid must be between 0 and the chitty amount." };
        model.bids2[key] = bid2;
      }
      if (base !== null || pct !== null) {
        if (base === null || pct === null || isNaN(base) || isNaN(pct) || base < 0 || pct < 0) {
          return { success: false, error: "Enter interest amount and percentage." };
        }
        if (base && pct) model.interest[key] = { base: base, pct: pct };
      }
    }
    return { success: true };
  });
}

function createLoginSheet(ss) {
  const sheet = ss.insertSheet(SHEET_LOGIN);
  // v2.9: header includes Script_URL for URL-based login validation
  sheet.appendRow(["User_ID", "Name", "Password", "API_Key", "Expire_Date", "Script_URL"]);
  sheet.appendRow(["admin", "Admin", "admin123", "", "", ""]);   // ← change after deploy
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 120); // User_ID
  sheet.setColumnWidth(2, 140); // Name
  sheet.setColumnWidth(3, 120); // Password
  sheet.setColumnWidth(4, 280); // API_Key
  sheet.setColumnWidth(5, 200); // Expire_Date
  sheet.setColumnWidth(6, 320); // Script_URL
  return sheet;
}

function setupSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(SHEET_LOGIN))  createLoginSheet(ss);
  if (!ss.getSheetByName(SHEET_SAVING)) getSavingSheet(ss);
  finSheetObj(ss);   // v4.0 — Finance tab
  chitSheetObj(ss);  // v4.1 — Chit Funds
  var curYear = new Date().getFullYear();
  MONTHS.forEach(function(m) { getMonthSheet(ss, monthSheetKey(m, curYear), true); });
  refreshAllYears(); // v3.3 — builds Master_<year>/OverExpense_<year> for every year found
  alignAllSheets();  // v4.3 — numbers centred, text left in existing data
  SpreadsheetApp.getUi().alert(
    "✅ Spendo v3.0 setup complete!\n\n" +
    "Login sheet columns: User_ID | Name | Password | API_Key | Expire_Date | Script_URL\n" +
    "Saving sheet: ID | Date | UserName | Bank | TxType | Amount | Remark | AmountDeductedFromSaving | RemainingSavingBalance | CreatedAt\n\n" +
    "The Script_URL column is optional — fill it with your deployed web app URL\n" +
    "to restrict logins to only that specific deployment.\n\n" +
    "Default credentials:\n  User ID  : admin\n  Password : admin123\n\n" +
    "Change passwords before sharing.\n" +
    "Admin (User_ID = admin) can see all users' transactions."
  );
}