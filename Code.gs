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
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

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
function mergeSplitRowsInSheet(sheet) {
  if (!sheet) return;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const data   = sheet.getRange(2, 1, lastRow - 1, MONTH_SHEET_COLS).getValues();
  const merged = mergeDuplicateIdRows(data.filter(function(row) { return row[0]; }));

  sheet.getRange(2, 1, lastRow - 1, MONTH_SHEET_COLS).clearContent();
  if (merged.length) sheet.getRange(2, 1, merged.length, MONTH_SHEET_COLS).setValues(merged);
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

  // Stable sort by CreatedAt ascending — true add order, independent of
  // whatever position the row currently sits at in the sheet.
  txRows = txRows
    .map(function(row, idx) { return { row: row, idx: idx }; })
    .sort(function(a, b) {
      let ta = a.row[7] ? new Date(a.row[7]).getTime() : NaN;
      let tb = b.row[7] ? new Date(b.row[7]).getTime() : NaN;
      if (isNaN(ta)) ta = a.idx;
      if (isNaN(tb)) tb = b.idx;
      return (ta - tb) || (a.idx - b.idx);
    })
    .map(function(x) { return x.row; });

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
  const sheet    = getMonthSheet(ss, monthSheetKey(month, year), true);
  const data     = sheet.getDataRange().getValues();
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
  refreshReports({ year: txYear }); // v3.3 — keep that year's Master/OverExpense in sync
  return { success: true, id: id, month: month };
}

function updateTransaction(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const month = p.month || getCurrentMonth();
  const year  = resolveYear(p);
  const sheetKey = monthSheetKey(month, year);
  const sheet = ss.getSheetByName(sheetKey);
  if (!sheet) return { success: false, error: "Month sheet '" + sheetKey + "' not found." };

  mergeSplitRowsInSheet(sheet); // v3.5 — reunite any split transaction halves before searching by ID
  const data = sheet.getDataRange().getValues();
  for (let r = 1; r < data.length; r++) {
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
    sheet.getRange(r + 1, 1, 1, 8).setValues([[
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
    refreshReports({ year: newYear }); // v3.3 — keep that year's Master/OverExpense in sync
    if (oldYear && oldYear !== newYear) refreshReports({ year: oldYear });
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

  mergeSplitRowsInSheet(sheet); // v3.5 — reunite any split transaction halves before searching by ID
  const data = sheet.getDataRange().getValues();
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][0]) === String(p.id)) {
      const delYear = rowYear(data[r]) || new Date().getFullYear();
      sheet.deleteRow(r + 1);
      rebuildMonthSheetOrder(sheet); // v3.5 — re-partition around the Over Usage divider
      refreshReports({ year: delYear }); // v3.3 — keep that year's Master/OverExpense in sync
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
  const sheet = getMonthSheet(ss, monthSheetKey(month, year), true);
  const data  = sheet.getDataRange().getValues();

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
  const sheet = getMonthSheet(ss, monthSheetKey(month, year), true);
  const data  = sheet.getDataRange().getValues();

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
  const sheet = getMonthSheet(ss, monthSheetKey(month, year), true);
  const data  = sheet.getDataRange().getValues();

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
  let income = 0, expense = 0;
  const catMap = {};
  if (!sheet) return { income: income, expense: expense, catMap: catMap };

  const data = sheet.getDataRange().getValues();
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    if (!row[0]) continue;
    if (rowYear(row) !== year) continue; // defensive — sheet is already year-scoped
    const type   = String(row[3]).trim();
    const cat    = String(row[4]).trim();
    const amount = parseFloat(row[5]) || 0;
    if (type === "Income")  income += amount;
    if (type === "Expense") {
      expense += amount;
      catMap[cat] = (catMap[cat] || 0) + amount;
    }
  }
  return { income: income, expense: expense, catMap: catMap };
}

// Single source of truth for Master/OverExpense/getMasterData — walks
// Jan → uptoIdx (default Dec) of one year and returns per-month figures,
// including the cumulative carry-forward (deficit-inclusive) and cumulative
// overuse (This Month / Previous / Total) so all three consumers stay
// identical. getMasterData passes uptoIdx = the requested month's index so
// it doesn't pay for sheet reads on months after the one being viewed.
function buildYearReport(ss, year, uptoIdx) {
  let carried           = 0;
  let cumulativeOveruse = 0;
  const monthly = [];
  const lastIdx = (uptoIdx === undefined || uptoIdx === null) ? MONTHS.length - 1 : uptoIdx;

  for (let idx = 0; idx <= lastIdx; idx++) {
    const month = MONTHS[idx];
    const t       = computeMonthTotals(ss, month, year);
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

      // Scale each category's spend down to only its share of the excess
      const scaleFactor = overuse / t.expense;
      const excessCatMap = {};
      Object.keys(t.catMap).forEach(function(cat) {
        const adjusted = Math.round(t.catMap[cat] * scaleFactor);
        if (adjusted > 0) excessCatMap[cat] = adjusted;
      });
      categoryBreakdown = Object.entries(excessCatMap)
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
      catMap: t.catMap // v3.6 — full month category totals, for Summary_<year>
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
function yearReportCacheKey(year) { return "yearReport_" + year; }

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
  highlightDividerRows(sheet, dividerRows, "#c9daf8"); // v3.6 — month divider highlight (light blue)

  sheet.setColumnWidth(1, 220);
  sheet.setColumnWidth(2, 130);
}

// Rebuilds OverExpense_<year>: a divider row per month where expense >
// income. Category amounts shown are scaled down to represent ONLY the
// excess-over-income portion (same proportional-scale technique used in
// getSavingSummary), not the month's full category spend.
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
// transaction's own year, so Master_<year>/OverExpense_<year> stay in sync.
function refreshReports(p) {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const year    = resolveYear(p);
  const monthly = getYearReportCached(ss, year, true); // force recompute — data just changed
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
    const y = parseInt(year, 10);
    const monthly = getYearReportCached(ss, y, true); // force recompute — bulk backfill
    refreshMasterSheet(ss, y, monthly);
    refreshOverExpenseSheet(ss, y, monthly);
    refreshSummarySheet(ss, y, monthly);
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
  sheet.appendRow([
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
  ]);

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

  sheet.appendRow([
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
  ]);

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
//  Every 1st of month: ensures current month's sheet exists, ensures
//  current year's Master_<year>/OverExpense_<year> exist (so year-start
//  = Jan 1 = also month-start, one trigger covers both), then deletes
//  any month-key sheet ("Jan26" etc.) that has zero transaction rows.
//
//  Run installTriggers() once from the Apps Script editor to activate.
// ─────────────────────────────────────────────────────────────

function monthlyAutoMaintenance() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const now   = new Date();
  const year  = now.getFullYear();
  const month = MONTHS[now.getMonth()];
  const curKey = monthSheetKey(month, year);

  getMonthSheet(ss, curKey, true);   // ensure this month's sheet exists
  refreshReports({ year: year });    // ensure this year's Master/OverExpense/Summary exist
  cleanupEmptyMonthSheets(curKey);
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

// One-time installer — run manually from the Apps Script editor.
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === "monthlyAutoMaintenance") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("monthlyAutoMaintenance")
    .timeBased()
    .onMonthDay(1)
    .atHour(0)
    .create();
}

// ─────────────────────────────────────────────────────────────
//  One-time setup  (run from Apps Script editor)
// ─────────────────────────────────────────────────────────────

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
  var curYear = new Date().getFullYear();
  MONTHS.forEach(function(m) { getMonthSheet(ss, monthSheetKey(m, curYear), true); });
  refreshAllYears(); // v3.3 — builds Master_<year>/OverExpense_<year> for every year found
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