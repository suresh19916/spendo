// Fake Apps Script world for the tests: loads Code.gs into a vm context
// with in-memory Calendar, Spreadsheet, triggers, properties and lock.
process.env.TZ = "Asia/Kolkata";

const fs     = require("node:fs");
const path   = require("node:path");
const vm     = require("node:vm");
const crypto = require("node:crypto");

const SRC = fs.readFileSync(path.join(__dirname, "..", "Code.gs"), "utf8");
const TZ  = "Asia/Kolkata";

function pad(n) { return String(n).padStart(2, "0"); }

function formatDate(d, tz, fmt) {
  const parts = {};
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(d).forEach(p => { parts[p.type] = p.value; });
  return fmt.replace("yyyy", parts.year).replace("MM", parts.month).replace("dd", parts.day)
            .replace("HH", parts.hour).replace("mm", parts.minute);
}

// Sheet over a 2D array (rows grow as written; values kept as given)
function fakeSheet(data) {
  return {
    getDataRange: () => ({ getValues: () => data.map(r => r.slice()) }),
    getLastRow: () => data.length,
    appendRow: row => { data.push(row.slice()); },
    setFrozenRows() {},
    getRange: (r, c, nr = 1, nc = 1) => ({
      setValues: vals => vals.forEach((row, i) => {
        const tgt = data[r - 1 + i] || (data[r - 1 + i] = []);
        row.forEach((v, j) => { tgt[c - 1 + j] = v; });
      }),
      clearContent: () => {
        for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) if (data[r - 1 + i]) data[r - 1 + i][c - 1 + j] = "";
        while (data.length && data[data.length - 1].every(v => v === "")) data.pop();
      },
      setNumberFormat() {}, setFontWeight() {}, setHorizontalAlignments() {}
    })
  };
}

// Builds a fresh fake Apps Script world. nowIso: local IST time, e.g. "2026-10-09T06:00".
function makeEnv({ nowIso, sheets = {}, props = {} }) {
  const NOW = new Date(nowIso).getTime();
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(NOW); }
    static now() { return NOW; }
  }

  // Calendars: the default one (events) and the pre-v4.10 separate one (oldEvents)
  let nextId = 1;
  function makeEvent(events, title, start, end) {
    const ev = {
      id: nextId++, title, start: new Date(start), end: new Date(end), desc: "", tags: {},
      popups: null, emails: [], deleted: false,
      getTag: k => ev.tags[k] || null, setTag: (k, v) => { ev.tags[k] = v; },
      getTitle: () => ev.title, setTitle: t => { ev.title = t; },
      getStartTime: () => new Date(ev.start), setTime: (s, e) => { ev.start = new Date(s); ev.end = new Date(e); },
      getDescription: () => ev.desc, setDescription: d => { ev.desc = d; },
      getPopupReminders: () => (ev.popups || []).slice(), getEmailReminders: () => ev.emails.slice(),
      removeAllReminders: () => { ev.popups = []; ev.emails = []; },
      addPopupReminder: m => { (ev.popups = ev.popups || []).push(m); },
      addEmailReminder: m => { ev.emails.push(m); },
      deleteEvent: () => { ev.deleted = true; events.splice(events.indexOf(ev), 1); }
    };
    events.push(ev);
    return ev;
  }
  function makeCalendar(id, name, events) {
    return {
      getId: () => id, getName: () => name,
      getEvents: (from, to) => events.filter(e => e.start < to && e.end > from),
      createEvent: (t, s, e, opts) => { const ev = makeEvent(events, t, s, e); ev.desc = (opts && opts.description) || ""; return ev; }
    };
  }
  const events = [], oldEvents = [];
  const calendar    = makeCalendar("owner@example.com", "owner@example.com", events);
  const oldCalendar = makeCalendar("old-cal", "Money Book Reminders", oldEvents);

  // Triggers
  const triggers = [];
  function builder(handler) {
    const t = { handler, spec: {} , getHandlerFunction: () => handler };
    const tb = {
      after: ms => { t.spec.after = ms; return tb; },
      at: d => { t.spec.at = new Date(d); return tb; },
      everyDays: n => { t.spec.everyDays = n; return tb; },
      everyMinutes: n => { t.spec.everyMinutes = n; return tb; },
      atHour: h => { t.spec.atHour = h; return tb; },
      nearMinute: m => { t.spec.nearMinute = m; return tb; },
      onMonthDay: d => { t.spec.onMonthDay = d; return tb; },
      create: () => { triggers.push(t); return t; }
    };
    return { timeBased: () => tb };
  }

  const propStore = Object.assign({}, props);

  const ctx = {
    Date: FakeDate, Math, JSON, console: { log() {}, error() {}, warn() {} },
    Logger: { log() {} },
    Session: { getScriptTimeZone: () => TZ, getEffectiveUser: () => ({ getEmail: () => "owner@example.com" }) },
    Utilities: { formatDate, getUuid: () => crypto.randomUUID() },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in propStore ? propStore[k] : null),
      setProperty: (k, v) => { propStore[k] = String(v); },
      deleteProperty: k => { delete propStore[k]; }
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock() {}, releaseLock() {} }) },
    CalendarApp: {
      getDefaultCalendar: () => calendar,
      getCalendarById: id => (id === "old-cal" ? oldCalendar : id === calendar.getId() ? calendar : null)
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: t => { triggers.splice(triggers.indexOf(t), 1); },
      newTrigger: builder
    },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({
      getSheetByName: name => (sheets[name] ? fakeSheet(sheets[name]) : null),
      insertSheet: name => fakeSheet(sheets[name] = [])
    }) }
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  // No loans / chits in these tests — keeps syncReminders focused on its own events
  ctx.computeFinance = () => [];
  ctx.parseFinance   = () => ({});
  ctx.computeChits   = () => [];
  ctx.parseChits     = () => ({});
  return { ctx, events, oldEvents, oldCalendar, triggers, props: propStore, sheets };
}

const HEADER = ["ID", "Date", "Name", "Type", "Category", "Amount", "Description", "CreatedAt"];
function oct26() {
  return { Oct26: [
    HEADER,
    ["a1", "2026-10-09", "suresh", "Expense", "Food",   120, "", ""],
    ["a2", "2026-10-09", "suresh", "Expense", "Travel", 250, "", ""],
    ["a3", "2026-10-09", "suresh", "Income",  "Salary", 5000, "", ""],
    ["a4", "2026-10-08", "suresh", "Expense", "Food",   999, "", ""],
    ["a5", "2026-10-09", "other",  "Expense", "Food",   40, "", ""],
    ["", "---------------- Over Usage Of Expenses ----------------", "", "", "", "", "", ""]
  ] };
}

function hm(d) { return formatDate(d, TZ, "yyyy-MM-dd HH:mm"); }
function byKey(events, key) { return events.filter(e => e.tags.mb === key); }

module.exports = { makeEnv, formatDate, hm, byKey, HEADER, oct26, TZ };
