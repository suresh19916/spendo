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
      case "getAdminReport":          return respond(getAdminReport(p));
      case "getMonthlySummaryReport": return respond(getMonthlySummaryReport(p)); // v2.6
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
  var sheet      = getMonthSheet(ss, month, true);
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

    // Preserve existing CreatedAt — never overwrite on edit
    const createdAt = data[r][7] ? String(data[r][7]) : new Date().toISOString();

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
  const userFilter = String(p.userName || "").trim();

  // ── Current month ───────────────────────────────────────────
  const sheet = getMonthSheet(ss, month, true);
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
  const curIdx         = MONTHS.indexOf(month);
  const monthlyBreakdown = [];   // [{month, balance}] for popup
  let   carriedBalance = 0;

  for (let i = 0; i < curIdx; i++) {
    const mName  = MONTHS[i];
    const mSheet = ss.getSheetByName(mName);
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
      const mBal = mInc - mExp;
      carriedBalance += mBal;
      monthlyBreakdown.push({ month: mName, balance: mBal });
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
// ─────────────────────────────────────────────────────────────
//  Monthly Summary Report  (v2.6 — admin only)
//  Consolidated all-users income, expense, balance + category
//  breakdown for the selected month.
// ─────────────────────────────────────────────────────────────

function getMonthlySummaryReport(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const month = p.month || getCurrentMonth();
  const sheet = getMonthSheet(ss, month, true);
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