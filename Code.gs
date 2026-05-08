// ============================================================
//  SPENDO – Google Apps Script Backend  v2.1
//  Deploy as: Web App → Execute as: Me → Who has access: Anyone
//
//  ALL actions are handled via GET (e.parameter).
//  The frontend sends every request as a GET with URL params,
//  which is the only reliable cross-origin approach for
//  Apps Script web apps without CORS preflight issues.
// ============================================================

const SHEET_LOGIN = "Login";
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// ─────────────────────────────────────────────────────────────
//  Entry points  (both doGet and doPost delegate to the same
//  handler; all params are read from e.parameter so GET works)
// ─────────────────────────────────────────────────────────────

function doGet(e)  { return handleRequest(e); }
function doPost(e) { return handleRequest(e); }

function handleRequest(e) {
  // Always read from e.parameter (populated for GET requests and
  // also available for POST when params are on the query string).
  const p      = e.parameter || {};
  const action = p.action    || "";

  try {
    if (action === "login") return respond(login(p));

    // Every other action requires a valid, non-expired API key
    const auth = validateApiKey(p.apiKey || "");
    if (!auth.valid) return respond({ success: false, error: auth.error });

    switch (action) {
      case "getTransactions":   return respond(getTransactions(p));
      case "addTransaction":    return respond(addTransaction(p));    // FIX: now uses p not postData
      case "updateTransaction": return respond(updateTransaction(p)); // FIX: now uses p not postData
      case "deleteTransaction": return respond(deleteTransaction(p));
      case "getSummary":        return respond(getSummary(p));
      default:                  return respond({ success: false, error: "Unknown action: " + action });
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
  const uidIdx  = headers.indexOf("User_ID");
  const pwIdx   = headers.indexOf("Password");
  const keyIdx  = headers.indexOf("API_Key");
  const expIdx  = headers.indexOf("Expire_Date");

  if (uidIdx < 0 || pwIdx < 0 || keyIdx < 0 || expIdx < 0) {
    return { success: false, error: "Login sheet columns are missing. Re-run setupSpreadsheet()." };
  }

  const userId   = String(p.userId   || "").trim();
  const password = String(p.password || "").trim();

  for (let r = 1; r < data.length; r++) {
    const rowUid = String(data[r][uidIdx]).trim();
    const rowPw  = String(data[r][pwIdx]).trim();
    if (rowUid === userId && rowPw === password) {
      // FIX: expiry is now 30 minutes (was 1 minute)
      const apiKey = generateKey();
      const expire = new Date(Date.now() + 30 * 60 * 1000);
      sheet.getRange(r + 1, keyIdx + 1).setValue(apiKey);
      sheet.getRange(r + 1, expIdx + 1).setValue(expire.toISOString());
      return { success: true, apiKey: apiKey, expiresAt: expire.toISOString() };
    }
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
    if (String(data[r][keyIdx]).trim() === String(apiKey).trim()) {
      const expireStr = data[r][expIdx];
      if (!expireStr) return { valid: false, error: "API key has no expiry date." };
      const expire = new Date(expireStr);
      if (isNaN(expire.getTime())) return { valid: false, error: "API key expiry date is invalid." };
      if (expire > new Date()) return { valid: true };
      return { valid: false, error: "Session expired. Please log in again." };
    }
  }
  return { valid: false, error: "Invalid API key." };
}

function generateKey() {
  return Utilities.getUuid().replace(/-/g, "");
}

// ─────────────────────────────────────────────────────────────
//  Transactions  (all params come from e.parameter = p)
// ─────────────────────────────────────────────────────────────

function getMonthSheet(ss, month, create) {
  let sheet = ss.getSheetByName(month);
  if (!sheet && create) {
    sheet = ss.insertSheet(month);
    sheet.appendRow(["ID", "Date", "Type", "Category", "Amount", "Description"]);
    sheet.setFrozenRows(1);
    // Basic column widths
    sheet.setColumnWidth(1, 120);
    sheet.setColumnWidth(2, 100);
    sheet.setColumnWidth(3, 80);
    sheet.setColumnWidth(4, 140);
    sheet.setColumnWidth(5, 80);
    sheet.setColumnWidth(6, 200);
  }
  return sheet;
}

function getTransactions(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const month = p.month || getCurrentMonth();
  const sheet = getMonthSheet(ss, month, true);
  const data  = sheet.getDataRange().getValues();
  const rows  = [];
  for (let r = 1; r < data.length; r++) {
    if (data[r][0]) rows.push(rowToObj(data[r]));
  }
  return { success: true, transactions: rows, month: month };
}

// FIX: addTransaction now reads from p (e.parameter), not e.postData
function addTransaction(p) {
  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const dateStr = p.date || new Date().toISOString().split("T")[0];
  const date   = new Date(dateStr);
  // Determine the correct month sheet from the transaction date
  const month  = isNaN(date.getTime()) ? getCurrentMonth() : MONTHS[date.getMonth()];
  const sheet  = getMonthSheet(ss, month, true);
  const id     = Utilities.getUuid().substring(0, 8);
  const amount = parseFloat(p.amount) || 0;

  sheet.appendRow([
    id,
    dateStr,
    p.type        || "Expense",
    p.category    || "Other",
    amount,
    p.description || ""
  ]);

  return { success: true, id: id, month: month };
}

// FIX: updateTransaction now reads from p (e.parameter), not e.postData
function updateTransaction(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const month = p.month || getCurrentMonth();
  const sheet = ss.getSheetByName(month);
  if (!sheet) return { success: false, error: "Month sheet '" + month + "' not found." };

  const data = sheet.getDataRange().getValues();
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][0]) === String(p.id)) {
      sheet.getRange(r + 1, 1, 1, 6).setValues([[
        p.id,
        p.date        || data[r][1],
        p.type        || data[r][2],
        p.category    || data[r][3],
        parseFloat(p.amount) || 0,
        p.description !== undefined ? p.description : data[r][5]
      ]]);
      return { success: true };
    }
  }
  return { success: false, error: "Transaction ID '" + p.id + "' not found in " + month + "." };
}

function deleteTransaction(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const month = p.month || getCurrentMonth();
  const sheet = ss.getSheetByName(month);
  if (!sheet) return { success: false, error: "Month sheet '" + month + "' not found." };

  const data = sheet.getDataRange().getValues();
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][0]) === String(p.id)) {
      sheet.deleteRow(r + 1);
      return { success: true };
    }
  }
  return { success: false, error: "Transaction ID '" + p.id + "' not found." };
}

function getSummary(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const month = p.month || getCurrentMonth();
  const sheet = getMonthSheet(ss, month, true);
  const data  = sheet.getDataRange().getValues();

  let income = 0, expense = 0;
  const catMap = {};

  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    if (!row[0]) continue;                         // skip empty rows
    const type   = String(row[2]).trim();
    const cat    = String(row[3]).trim();
    const amount = parseFloat(row[4]) || 0;
    if (type === "Income")  income  += amount;
    if (type === "Expense") expense += amount;
    if (type === "Expense") catMap[cat] = (catMap[cat] || 0) + amount;
  }

  const topCategories = Object.entries(catMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(function(entry) { return { name: entry[0], amount: entry[1] }; });

  const balance    = income - expense;
  const budget     = p.budget ? parseFloat(p.budget) : income;
  const budgetUsed = budget > 0 ? Math.round((expense / budget) * 100) : (expense > 0 ? 100 : 0);

  return {
    success:        true,
    month:          month,
    income:         income,
    expense:        expense,
    balance:        balance,
    budgetUsed:     budgetUsed,
    topCategories:  topCategories
  };
}

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────

function rowToObj(row) {
  return {
    id:          String(row[0]),
    date:        row[1] ? String(row[1]).split("T")[0] : "",
    type:        String(row[2]),
    category:    String(row[3]),
    amount:      parseFloat(row[4]) || 0,
    description: String(row[5] || "")
  };
}

function getCurrentMonth() {
  return MONTHS[new Date().getMonth()];
}

// ─────────────────────────────────────────────────────────────
//  One-time setup  (run manually from Apps Script editor)
// ─────────────────────────────────────────────────────────────

function createLoginSheet(ss) {
  const sheet = ss.insertSheet(SHEET_LOGIN);
  sheet.appendRow(["User_ID", "Password", "API_Key", "Expire_Date"]);
  sheet.appendRow(["admin", "admin123", "", ""]);  // ← change password after deploy
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 120);
  sheet.setColumnWidth(2, 120);
  sheet.setColumnWidth(3, 280);
  sheet.setColumnWidth(4, 200);
  return sheet;
}

function setupSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Create Login sheet if missing
  if (!ss.getSheetByName(SHEET_LOGIN)) createLoginSheet(ss);

  // Create all 12 monthly sheets if missing
  MONTHS.forEach(function(m) { getMonthSheet(ss, m, true); });

  SpreadsheetApp.getUi().alert(
    "✅ Spendo setup complete!\n\n" +
    "Default login credentials:\n" +
    "  User ID  : admin\n" +
    "  Password : admin123\n\n" +
    "Change the password in the Login sheet before sharing."
  );
}
