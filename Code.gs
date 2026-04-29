// ============================================================
//  SPENDO — Google Apps Script Backend  (FIXED v2)
//  
//  IMPORTANT AFTER PASTING THIS CODE:
//  Deploy → New Deployment → Web App
//  Execute as: Me
//  Who has access: Anyone
//  ⚠️ Always create a NEW deployment after any code change!
// ============================================================

var TX_SHEET = "Transactions";

// ── Apps Script only supports GET reliably from external sites
//    We pass everything as URL query parameters
function doGet(e) {
  var result;
  try {
    var p      = e.parameter || {};
    var action = p.action    || "";

    switch (action) {
      case "getTx":     result = getTx(p);     break;
      case "addTx":     result = addTx(p);     break;
      case "deleteTx":  result = deleteTx(p);  break;
      case "ping":      result = { ok: true, msg: "Spendo connected!" }; break;
      default:          result = { ok: false, error: "Unknown action: " + action };
    }
  } catch (err) {
    result = { ok: false, error: err.toString() };
  }

  // ── CORS: return JSONP if callback provided, else plain JSON
  var cb = (e.parameter && e.parameter.callback) ? e.parameter.callback : null;
  var json = JSON.stringify(result);
  if (cb) {
    return ContentService
      .createTextOutput(cb + "(" + json + ")")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Also handle POST (for future use) ────────────────────────
function doPost(e) {
  return doGet(e); // re-use same logic
}

// ── Sheet helpers ─────────────────────────────────────────────
function getOrCreateSheet(name, headers) {
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

function txSheet() {
  return getOrCreateSheet(TX_SHEET, [
    "ID","Type","Amount","Description","Category","Date","Emoji","MonthKey"
  ]);
}

// ── GET TRANSACTIONS ─────────────────────────────────────────
function getTx(p) {
  var sheet    = txSheet();
  var data     = sheet.getDataRange().getValues();
  var monthKey = p.monthKey || "";
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

// ── ADD TRANSACTION ──────────────────────────────────────────
function addTx(p) {
  var sheet = txSheet();
  var id    = String(new Date().getTime());
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
  sheet.autoResizeColumns(1, 8);
  return { ok: true, id: id };
}

// ── DELETE TRANSACTION ───────────────────────────────────────
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


