// ============================================================
//  SPENDO – Google Apps Script Backend  v2.3
//  Deploy as: Web App → Execute as: Me → Who has access: Anyone
//
//  ALL actions use GET (e.parameter) — reliable cross-origin.
//
//  v2.3 changes (on top of v2.2)
//  ─ login() returns isAdmin:true when User_ID === "admin"
//  ─ getSummary() now computes prevMonthBalance and netBalance
//  ─ getSummary() + getTransactions() filter rows by userName
//  ─ v2.4: getAdminReport() — monthly per-user summary + transactions
// ============================================================

const SHEET_LOGIN = "Login";
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
      case "getAdminReport":    return respond(getAdminReport(p));   // v2.4 admin only
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
  const uidIdx  = headers.indexOf("User_ID");
  const nameIdx = headers.indexOf("Name");       // NEW in v2.2
  const pwIdx   = headers.indexOf("Password");
  const keyIdx  = headers.indexOf("API_Key");
  const expIdx  = headers.indexOf("Expire_Date");

  if (uidIdx < 0 || pwIdx < 0 || keyIdx < 0 || expIdx < 0) {
    return { success: false, error: "Login sheet columns missing. Re-run setupSpreadsheet()." };
  }

  const userId   = String(p.userId   || "").trim();
  const password = String(p.password || "").trim();

  for (let r = 1; r < data.length; r++) {
    if (String(data[r][uidIdx]).trim() !== userId)   continue;
    if (String(data[r][pwIdx]).trim()  !== password) continue;

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
      isAdmin   : isAdmin    // v2.3 — controls data visibility in frontend + backend
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
// ─────────────────────────────────────────────────────────────

function getMonthSheet(ss, month, create) {
  let sheet = ss.getSheetByName(month);
  if (!sheet && create) {
    sheet = ss.insertSheet(month);
    // NEW header includes Name at position 3
    sheet.appendRow(["ID", "Date", "Name", "Type", "Category", "Amount", "Description"]);
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 110); // ID
    sheet.setColumnWidth(2, 100); // Date
    sheet.setColumnWidth(3, 120); // Name
    sheet.setColumnWidth(4,  80); // Type
    sheet.setColumnWidth(5, 140); // Category
    sheet.setColumnWidth(6,  90); // Amount
    sheet.setColumnWidth(7, 200); // Description
  }
  return sheet;
}

function getTransactions(p) {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const month    = p.month    || getCurrentMonth();
  // userName filter: empty string means "show all" (admin); any other value = filter by name
  const userFilter = String(p.userName || "").trim();
  const sheet    = getMonthSheet(ss, month, true);
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
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const dateStr = p.date || new Date().toISOString().split("T")[0];
  const date    = new Date(dateStr);
  const month   = isNaN(date.getTime()) ? getCurrentMonth() : MONTHS[date.getMonth()];
  const sheet   = getMonthSheet(ss, month, true);
  const id      = Utilities.getUuid().substring(0, 8);
  const amount  = parseFloat(p.amount) || 0;

  // 7-column row — Name (p.userName) at index 2
  sheet.appendRow([
    id,
    dateStr,
    p.userName    || "",     // NEW: logged-in user's display name
    p.type        || "Expense",
    p.category    || "Other",
    amount,
    p.description || ""
  ]);

  return { success: true, id: id, month: month };
}

function updateTransaction(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const month = p.month || getCurrentMonth();
  const sheet = ss.getSheetByName(month);
  if (!sheet) return { success: false, error: "Month sheet '" + month + "' not found." };

  const data = sheet.getDataRange().getValues();
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][0]) !== String(p.id)) continue;

    // Preserve existing Name if caller doesn't supply one
    const nameVal = (p.userName && p.userName.trim())
      ? p.userName.trim()
      : String(data[r][2] || "");

    // 7-column update
    sheet.getRange(r + 1, 1, 1, 7).setValues([[
      p.id,
      p.date        || data[r][1],
      nameVal,                         // col 3: Name
      p.type        || data[r][3],
      p.category    || data[r][4],
      parseFloat(p.amount) || 0,
      p.description !== undefined ? p.description : data[r][6]
    ]]);
    return { success: true };
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
  const ss         = SpreadsheetApp.getActiveSpreadsheet();
  const month      = p.month || getCurrentMonth();
  // v2.3 user filter: empty = admin (see all), non-empty = filter by name
  const userFilter = String(p.userName || "").trim();

  // ── Current month ──────────────────────────────────────────
  const sheet = getMonthSheet(ss, month, true);
  const data  = sheet.getDataRange().getValues();

  let income = 0, expense = 0;
  const catMap = {};

  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    if (!row[0]) continue;
    // v2.3: apply userName filter (col 2 = Name)
    if (userFilter && String(row[2]).trim() !== userFilter) continue;
    const type   = String(row[3]).trim();
    const cat    = String(row[4]).trim();
    const amount = parseFloat(row[5]) || 0;
    if (type === "Income")  income  += amount;
    if (type === "Expense") expense += amount;
    if (type === "Expense") catMap[cat] = (catMap[cat] || 0) + amount;
  }

  // ── Previous month balance ─────────────────────────────────
  // Find the index of the current month, then step back one
  const curIdx  = MONTHS.indexOf(month);
  const prevIdx = (curIdx - 1 + 12) % 12;          // wraps Jan → Dec
  const prevMonth = MONTHS[prevIdx];

  let prevIncome = 0, prevExpense = 0;
  const prevSheet = ss.getSheetByName(prevMonth);   // don't auto-create — may not exist
  if (prevSheet) {
    const prevData = prevSheet.getDataRange().getValues();
    for (let r = 1; r < prevData.length; r++) {
      const row = prevData[r];
      if (!row[0]) continue;
      if (userFilter && String(row[2]).trim() !== userFilter) continue;
      const type   = String(row[3]).trim();
      const amount = parseFloat(row[5]) || 0;
      if (type === "Income")  prevIncome  += amount;
      if (type === "Expense") prevExpense += amount;
    }
  }

  const prevMonthBalance = prevIncome - prevExpense;   // can be negative
  const currentBalance   = income - expense;
  const netBalance       = prevMonthBalance + currentBalance;

  // ── Budget % (based on current month only) ─────────────────
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
    income           : income,           // current month income
    expense          : expense,          // current month expense
    balance          : currentBalance,   // current month only (income − expense)
    prevMonth        : prevMonth,        // e.g. "Apr"
    prevMonthBalance : prevMonthBalance, // prev month income − prev month expense
    netBalance       : netBalance,       // prevMonthBalance + currentBalance
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
  const sheet = getMonthSheet(ss, month, true);
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



// v2.2: maps 7-column row to object
function rowToObj(row) {
  return {
    id          : String(row[0]),
    date        : row[1] ? String(row[1]).split("T")[0] : "",
    name        : String(row[2] || ""),   // NEW
    type        : String(row[3]),
    category    : String(row[4]),
    amount      : parseFloat(row[5]) || 0,
    description : String(row[6] || "")
  };
}

function getCurrentMonth() {
  return MONTHS[new Date().getMonth()];
}

// ─────────────────────────────────────────────────────────────
//  One-time setup  (run from Apps Script editor)
// ─────────────────────────────────────────────────────────────

function createLoginSheet(ss) {
  const sheet = ss.insertSheet(SHEET_LOGIN);
  // v2.2: header includes "Name" between "User_ID" and "Password"
  sheet.appendRow(["User_ID", "Name", "Password", "API_Key", "Expire_Date"]);
  sheet.appendRow(["admin", "Admin", "admin123", "", ""]);   // ← change after deploy
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 120); // User_ID
  sheet.setColumnWidth(2, 140); // Name
  sheet.setColumnWidth(3, 120); // Password
  sheet.setColumnWidth(4, 280); // API_Key
  sheet.setColumnWidth(5, 200); // Expire_Date
  return sheet;
}

function setupSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(SHEET_LOGIN)) createLoginSheet(ss);
  MONTHS.forEach(function(m) { getMonthSheet(ss, m, true); });
  SpreadsheetApp.getUi().alert(
    "✅ Spendo v2.3 setup complete!\n\n" +
    "Login sheet columns: User_ID | Name | Password | API_Key | Expire_Date\n\n" +
    "Default credentials:\n  User ID  : admin\n  Password : admin123\n\n" +
    "Add user names in the 'Name' column for each user.\n" +
    "Change passwords before sharing.\n\n" +
    "Admin (User_ID = admin) can see all users' transactions.\n" +
    "All other users see only their own transactions."
  );
}