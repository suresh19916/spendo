// ============================================================
//  SPENDO — Google Apps Script Backend  (FIXED v4)
//
//  HOW TO DEPLOY:
//  1. Paste this entire file into Apps Script editor
//  2. Deploy → New Deployment → Web App
//     Execute as: Me | Who has access: Anyone
//  3. Copy the /exec URL into your app
//  ⚠️ After ANY code change → create a NEW deployment version
// ============================================================

var TX_SHEET     = "Transactions";
var SALARY_SHEET = "Salary";
var LOGIN_SHEET  = "Login";

// ── ENTRY POINT ──────────────────────────────────────────────
function doGet(e) {
  var result;
  try {
    var p      = e.parameter || {};
    var action = p.action    || "";
    Logger.log("Action: " + action + " | Params: " + JSON.stringify(p));

    switch (action) {
      case "ping":         result = { ok: true, msg: "Spendo connected!" };    break;
      case "login":        result = handleLogin(p);                            break;
      case "validateKey":  result = validateApiKey(p);                         break;
      case "getTx":        result = secure(p, getTx);                          break;
      case "addTx":        result = secure(p, addTx);                          break;
      case "deleteTx":     result = secure(p, deleteTx);                       break;
      case "getSalary":    result = secure(p, getSalary);                      break;
      case "setSalary":    result = secure(p, setSalary);                      break;
      default:
        result = { ok: false, error: "Unknown action: " + action };
    }
  } catch (err) {
    Logger.log("Error: " + err.toString());
    result = { ok: false, error: err.toString() };
  }

  // JSONP support (needed to bypass CORS from GitHub Pages)
  var cb   = e.parameter && e.parameter.callback ? e.parameter.callback : null;
  var json = JSON.stringify(result);
  return ContentService
    .createTextOutput(cb ? cb + "(" + json + ")" : json)
    .setMimeType(cb ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
}

function doPost(e) { return doGet(e); }

// ── API KEY GUARD ─────────────────────────────────────────────
function secure(p, fn) {
  var v = validateApiKey(p);
  if (!v.ok) return v;
  return fn(p);
}

// ── SHEET HELPERS ─────────────────────────────────────────────
function getOrCreate(name, headers) {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length)
         .setBackground("#1e1e28")
         .setFontColor("#d4f74a")
         .setFontWeight("bold");
  }
  return sheet;
}

function txSheet()     { return getOrCreate(TX_SHEET,     ["ID","Type","Amount","Description","Category","Date","Emoji","MonthKey"]); }
function salSheet()    { return getOrCreate(SALARY_SHEET, ["MonthKey","Salary"]); }
function loginSheet()  { return getOrCreate(LOGIN_SHEET,  ["UserID","Password","APIKey","Expiry"]); }

// ── LOGIN ─────────────────────────────────────────────────────
function handleLogin(p) {
  var userId   = String(p.userId   || "").trim();
  var password = String(p.password || "").trim();
  Logger.log("Login attempt for userId: '" + userId + "'");

  if (!userId || !password) {
    return { ok: false, error: "Missing credentials" };
  }

  var sheet = loginSheet();
  var data  = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (String(row[0]).trim() === userId && String(row[1]).trim() === password) {
      var apiKey  = generateKey();
      // SESSION: 8 hours (adjust as needed)
      var expiry  = new Date(Date.now() + 8 * 60 * 60 * 1000);
      sheet.getRange(i + 1, 3).setValue(apiKey);
      sheet.getRange(i + 1, 4).setValue(expiry.toISOString());
      Logger.log("Login OK for: " + userId);
      return { ok: true, apiKey: apiKey, expiry: expiry.toISOString() };
    }
  }

  Logger.log("Login FAILED for: " + userId);
  return { ok: false, error: "Invalid credentials" };
}

function validateApiKey(p) {
  var apiKey = String(p.apiKey || "").trim();
  if (!apiKey) return { ok: false, error: "Missing API key" };

  var sheet = loginSheet();
  var data  = sheet.getDataRange().getValues();
  var now   = new Date();

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (String(row[2]).trim() === apiKey) {
      var expiry = new Date(row[3]);
      if (isNaN(expiry.getTime())) return { ok: false, error: "Invalid session" };
      if (now > expiry) {
        // Clear expired key
        sheet.getRange(i + 1, 3).setValue("");
        sheet.getRange(i + 1, 4).setValue("");
        return { ok: false, error: "Session expired. Please login again." };
      }
      return { ok: true };
    }
  }
  return { ok: false, error: "Invalid API key" };
}

function generateKey() {
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  var key   = "SPD_";
  for (var i = 0; i < 32; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key;
}

// ── TRANSACTIONS ──────────────────────────────────────────────
function getTx(p) {
  var sheet    = txSheet();
  var data     = sheet.getDataRange().getValues();
  var monthKey = String(p.monthKey || "");
  var rows     = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (!row[0]) continue;
    if (monthKey && String(row[7]) !== monthKey) continue;
    rows.push({
      id:     String(row[0]),
      type:   String(row[1]),
      amount: parseFloat(row[2]) || 0,
      desc:   String(row[3]),
      cat:    String(row[4]),
      date:   String(row[5]),
      emoji:  String(row[6]),
      month:  String(row[7])
    });
  }
  return { ok: true, data: rows };
}

function addTx(p) {
  var sheet = txSheet();
  var id    = String(Date.now());
  sheet.appendRow([
    id,
    p.type    || "expense",
    parseFloat(p.amount) || 0,
    p.desc    || "",
    p.cat     || "Other",
    p.date    || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd"),
    p.emoji   || "💳",
    p.monthKey || ""
  ]);
  return { ok: true, id: id };
}

function deleteTx(p) {
  var sheet = txSheet();
  var data  = sheet.getDataRange().getValues();
  var id    = String(p.id || "");

  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]) === id) {
      sheet.deleteRow(i + 1);
      return { ok: true };
    }
  }
  return { ok: false, error: "Row not found: " + id };
}

// ── SALARY ────────────────────────────────────────────────────
function getSalary(p) {
  var sheet    = salSheet();
  var data     = sheet.getDataRange().getValues();
  var monthKey = String(p.monthKey || "");

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === monthKey) {
      return { ok: true, salary: parseFloat(data[i][1]) || 0 };
    }
  }
  return { ok: true, salary: 0 };
}

function setSalary(p) {
  var sheet    = salSheet();
  var data     = sheet.getDataRange().getValues();
  var monthKey = String(p.monthKey || "");
  var amount   = parseFloat(p.salary) || 0;

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === monthKey) {
      sheet.getRange(i + 1, 2).setValue(amount);
      return { ok: true };
    }
  }
  sheet.appendRow([monthKey, amount]);
  return { ok: true };
}

// ── USER MANAGEMENT (run manually in Apps Script) ─────────────
// To add a user: open Apps Script → run addUser() after filling in details
function addUser() {
  // ✏️ Change these values before running:
  var USER_ID  = "admin";
  var PASSWORD = "admin123";
  // ────────────────────────────────────────

  var sheet = loginSheet();
  var data  = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === USER_ID) {
      throw new Error("User already exists: " + USER_ID);
    }
  }
  sheet.appendRow([USER_ID, PASSWORD, "", ""]);
  Logger.log("User created: " + USER_ID);
  return "User '" + USER_ID + "' created successfully";
}