// Tests for the calendar side of the reminders in Code.gs: spend amounts,
// loan / chit due events, sync, triggers.
// Run: npm test
const test   = require("node:test");
const assert = require("node:assert/strict");
const { makeEnv, hm, byKey, HEADER, oct26 } = require("./gas-env");

const plain = v => JSON.parse(JSON.stringify(v));

function add(ctx, fields) {
  const res = ctx.saveNotification(Object.assign({ date: "2026-01-01", time: "21:00", repeat: "daily" }, fields));
  assert.equal(res.success, true, res.error);
  return res.id;
}

test("remSpent sums one day's expenses, skips income / other days / divider", () => {
  const { ctx } = makeEnv({ nowIso: "2026-10-09T20:30", sheets: oct26() });
  const ss = ctx.SpreadsheetApp.getActiveSpreadsheet();
  assert.equal(ctx.remSpent(ss, 9, 2026, "2026-10-09"), 410);
  assert.equal(ctx.remSpent(ss, 9, 2026), 1409);
  assert.equal(ctx.remSpent(ss, 9, 2026, "2026-10-09", "suresh"), 370);
});

test("inr uses Indian digit grouping", () => {
  const { ctx } = makeEnv({ nowIso: "2026-10-09T06:00" });
  assert.equal(ctx.inr(370), "₹370");
  assert.equal(ctx.inr(123456), "₹1,23,456");
  assert.equal(ctx.inr(-5000), "-₹5,000");
});

test("today_spend: today's event shows the user's amount, later days just the title", () => {
  const env = makeEnv({ nowIso: "2026-10-09T06:00", sheets: oct26(), props: { REM_READY: "on" } });
  const id = add(env.ctx, { type: "today_spend", title: "Today spent", userName: "suresh" });
  env.ctx.syncReminders();
  const today = byKey(env.events, `cn|${id}|2026-10-09`)[0];
  assert.equal(today.title, "Today spent ₹370");
  assert.equal(hm(today.start), "2026-10-09 21:00");
  assert.deepEqual(plain(today.popups), [0, 60]);
  assert.deepEqual(plain(today.emails), []);
  assert.equal(byKey(env.events, `cn|${id}|2026-10-10`)[0].title, "Today spent");
});

test("month_spend and last_month amounts", () => {
  const sheets = Object.assign(oct26(), {
    Sep26: [HEADER, ["s1", "2026-09-15", "suresh", "Expense", "Food", 30000, "", ""]],
    Dec25: [HEADER, ["d1", "2025-12-15", "suresh", "Expense", "Food", 700, "", ""]]
  });
  const env = makeEnv({ nowIso: "2026-10-09T06:00", sheets, props: { REM_READY: "on" } });
  const m = add(env.ctx, { type: "month_spend", title: "This month", date: "2026-10-09", repeat: "none" });
  const l = add(env.ctx, { type: "last_month", title: "Last month", date: "2026-10-09", repeat: "none" });
  env.ctx.syncReminders();
  assert.equal(byKey(env.events, `cn|${m}|2026-10-09`)[0].title, "This month ₹1,409");
  assert.equal(byKey(env.events, `cn|${l}|2026-10-09`)[0].title, "Last month ₹30,000");

  // January → last month is December of the previous year
  const jan = makeEnv({ nowIso: "2026-01-01T06:00", sheets, props: { REM_READY: "on" } });
  const j = add(jan.ctx, { type: "last_month", title: "Last month", date: "2026-01-01", repeat: "monthly", time: "09:00" });
  jan.ctx.syncReminders();
  assert.equal(byKey(jan.events, `cn|${j}|2026-01-01`)[0].title, "Last month ₹700");
});

test("refreshReminderAmounts updates today's spend title in place", () => {
  const sheets = oct26();
  const env = makeEnv({ nowIso: "2026-10-09T06:00", sheets, props: { REM_READY: "on" } });
  const id = add(env.ctx, { type: "today_spend", title: "Today spent", userName: "suresh" });
  env.ctx.syncReminders();
  const ev = byKey(env.events, `cn|${id}|2026-10-09`)[0];

  sheets.Oct26.push(["a6", "2026-10-09", "suresh", "Expense", "Food", 90, "", ""]);
  env.ctx.refreshReminderAmounts();
  const after = byKey(env.events, `cn|${id}|2026-10-09`);
  assert.equal(after.length, 1);
  assert.equal(after[0].id, ev.id);
  assert.equal(after[0].title, "Today spent ₹460");
});

test("old trigger name dailyExpenseSummary still works (refreshes amounts)", () => {
  const sheets = oct26();
  const env = makeEnv({ nowIso: "2026-10-09T06:00", sheets, props: { REM_READY: "on" } });
  const id = add(env.ctx, { type: "today_spend", title: "Spent" });
  env.ctx.syncReminders();
  sheets.Oct26.push(["a6", "2026-10-09", "x", "Expense", "Food", 1, "", ""]);
  env.ctx.dailyExpenseSummary();
  assert.equal(byKey(env.events, `cn|${id}|2026-10-09`)[0].title, "Spent ₹411");
});

function finEnv(nowIso) {
  const env = makeEnv({ nowIso, props: { REM_READY: "on" } });
  env.ctx.computeFinance = () => [
    { id: "p1", name: "Yog", userName: "suresh", pending: 12000, rows: [
      { month: "2026-10", dueDate: "2026-10-12", received: "No",  interest: 6000, collected: 0 },
      { month: "2026-09", dueDate: "2026-09-12", received: "No",  interest: 6000, collected: 0 },
      { month: "2026-11", dueDate: "2026-11-12", received: "Yes", interest: 6000, collected: 6000 }] },
    { id: "p2", name: "Ravi's guy", userName: "ravi", pending: 0, rows: [
      { month: "2026-10", dueDate: "2026-10-15", received: "No", interest: 100, collected: 0 }] }
  ];
  env.ctx.computeChits = () => [
    { id: "c1", name: "Office chit", userName: "suresh", type: "commission", monthlyDue: 5000, rows: [
      { month: "2026-10", date: "2026-10-20", payable: 4200 },
      { month: "2026-11", date: "2026-11-20", payable: null },
      { month: "2026-11b", date: "2026-11-20", second: true }] }
  ];
  return env;
}

test("loan reminder: due / received / pending events of the user's loans at its time", () => {
  const env = finEnv("2026-10-09T06:00");
  const id = add(env.ctx, { type: "loan", title: "Hand loan dues", time: "08:30", userName: "suresh" });
  env.ctx.syncReminders();
  const mine = env.events.filter(e => e.tags.mb.startsWith(`cn|${id}|`));
  assert.deepEqual(plain(mine.map(e => e.title).sort()), [
    "Yog ₹12,000 interest pending", "Yog ₹6,000 interest due", "Yog ₹6,000 interest received"]);
  const due = byKey(env.events, `cn|${id}|p1|2026-10`)[0];
  assert.equal(hm(due.start), "2026-10-12 08:30");
  assert.deepEqual(plain(due.popups).sort((a, b) => a - b), [0, 60, 1440]);
  assert.deepEqual(plain(due.emails), []);
  assert.deepEqual(plain(byKey(env.events, `cn|${id}|p1|2026-11`)[0].popups), []);
  assert.equal(hm(byKey(env.events, `cn|${id}|pend|p1|2026-10-09`)[0].start), "2026-10-09 08:30");
});

test("chit reminder: one event per chit date, bid payable when known", () => {
  const env = finEnv("2026-10-09T06:00");
  const id = add(env.ctx, { type: "chit", title: "Chit dues", time: "09:00", userName: "suresh" });
  env.ctx.syncReminders();
  assert.equal(byKey(env.events, `cn|${id}|c1|2026-10`)[0].title, "Office chit ₹4,200 due");
  assert.equal(byKey(env.events, `cn|${id}|c1|2026-11`)[0].title, "Office chit ₹5,000 due");
  assert.equal(env.events.length, 2);
});

test("sync removes pre-v4.8 built-in events and events of deleted / switched-off reminders", () => {
  const env = makeEnv({ nowIso: "2026-10-09T06:00", sheets: oct26(), props: { REM_READY: "on" } });
  const cal = env.ctx.CalendarApp.getDefaultCalendar();
  for (const k of ["sum|2026-10-09", "sum|upd|2026-10-09", "loan|p1|2026-10", "chit|c1|2026-10"]) {
    cal.createEvent("old", new Date("2026-10-09T21:00"), new Date("2026-10-09T21:15")).setTag("mb", k);
  }
  cal.createEvent("not ours", new Date("2026-10-09T10:00"), new Date("2026-10-09T11:00"));
  const id = add(env.ctx, { type: "text", title: "Update expenses", date: "2026-10-09", repeat: "none" });
  env.ctx.syncReminders();
  assert.deepEqual(plain(env.events.map(e => e.title).sort()), ["Update expenses", "not ours"]);

  env.ctx.saveNotification({ id, type: "text", title: "Update expenses", date: "2026-10-09", time: "21:00", active: "No" });
  env.ctx.syncReminders();
  assert.deepEqual(plain(env.events.map(e => e.title)), ["not ours"]);
});

test("sync fixes reminders that were changed on the event by hand", () => {
  const env = makeEnv({ nowIso: "2026-10-09T06:00", props: { REM_READY: "on" } });
  const id = add(env.ctx, { title: "X", date: "2026-10-09", repeat: "none" });
  env.ctx.syncReminders();
  const ev = byKey(env.events, `cn|${id}|2026-10-09`)[0];
  ev.removeAllReminders();
  ev.addPopupReminder(10);
  env.ctx.syncReminders();
  assert.deepEqual(plain(ev.popups), [0, 60]);
  assert.deepEqual(plain(ev.emails), []);
});

test("setupReminders installs the 6 AM sync and 30-minute amount refresh, drops old triggers", () => {
  const env = makeEnv({ nowIso: "2026-10-09T10:00" });
  env.ctx.ScriptApp.newTrigger("dailyExpenseSummary").timeBased().everyDays(1).create();
  env.ctx.ScriptApp.newTrigger("sendDuePushes").timeBased().everyMinutes(5).create();
  env.ctx.setupReminders();
  env.ctx.setupReminders();
  assert.deepEqual(plain(env.triggers.map(t => t.handler).sort()), ["morningReminders", "refreshReminderAmounts"]);
  assert.equal(env.triggers.find(t => t.handler === "refreshReminderAmounts").spec.everyMinutes, 30);
});

test("several loans / chits: one event each, even on the same day", () => {
  const env = makeEnv({ nowIso: "2026-10-09T06:00", props: { REM_READY: "on" } });
  const row = (month, dueDate, interest) => ({ month, dueDate, received: "No", interest, collected: 0 });
  env.ctx.computeFinance = () => [
    { id: "p1", name: "Yog",  userName: "u", pending: 6000, rows: [row("2026-10", "2026-10-12", 6000)] },
    { id: "p2", name: "Ravi", userName: "u", pending: 0,    rows: [row("2026-10", "2026-10-12", 2000)] },
    { id: "p3", name: "Mani", userName: "u", pending: 1500, rows: [row("2026-10", "2026-10-20", 1500)] }
  ];
  const chit = (id, name, amt) => ({ id, name, userName: "u", type: "commission", monthlyDue: amt,
                                     rows: [{ month: "2026-10", date: "2026-10-15", payable: null }] });
  env.ctx.computeChits = () => [chit("c1", "Office chit", 5000), chit("c2", "Family chit", 3000)];
  add(env.ctx, { type: "loan", title: "Loans", time: "09:00", userName: "u" });
  add(env.ctx, { type: "chit", title: "Chits", time: "09:00", userName: "u" });
  env.ctx.syncReminders();

  const titles = plain(env.events.map(e => `${hm(e.start)} ${e.title}`).sort());
  assert.deepEqual(titles, [
    "2026-10-09 09:00 Mani ₹1,500 interest pending",
    "2026-10-09 09:00 Yog ₹6,000 interest pending",
    "2026-10-12 09:00 Ravi ₹2,000 interest due",
    "2026-10-12 09:00 Yog ₹6,000 interest due",
    "2026-10-15 09:00 Family chit ₹3,000 due",
    "2026-10-15 09:00 Office chit ₹5,000 due",
    "2026-10-20 09:00 Mani ₹1,500 interest due"
  ]);
});

test("closed loans / chits get no reminders", () => {
  const env = makeEnv({ nowIso: "2026-10-09T06:00", props: { REM_READY: "on" } });
  const row = { month: "2026-10", dueDate: "2026-10-12", received: "No", interest: 2000, collected: 0 };
  env.ctx.computeFinance = () => [
    { id: "p1", name: "Yog",  userName: "u", pending: 6000, rows: [row], closed: "2026-10-01" },
    { id: "p2", name: "Ravi", userName: "u", pending: 0,    rows: [row], closed: "" }
  ];
  const chit = (id, name, closed) => ({ id, name, userName: "u", type: "commission", monthlyDue: 5000, closed,
                                        rows: [{ month: 1, date: "2026-10-15", payable: null }] });
  env.ctx.computeChits = () => [chit("c1", "Old chit", true), chit("c2", "Office chit", false)];
  add(env.ctx, { type: "loan", title: "Loans", time: "09:00", userName: "u" });
  add(env.ctx, { type: "chit", title: "Chits", time: "09:00", userName: "u" });
  env.ctx.syncReminders();

  const titles = plain(env.events.map(e => e.title).sort());
  assert.deepEqual(titles, ["Office chit ₹5,000 due", "Ravi ₹2,000 interest due"]);
});

test("sync strips email reminders left on events by earlier versions", () => {
  const env = makeEnv({ nowIso: "2026-10-09T06:00", props: { REM_READY: "on" } });
  const id = add(env.ctx, { title: "X", date: "2026-10-09", repeat: "none" });
  env.ctx.syncReminders();
  const ev = byKey(env.events, `cn|${id}|2026-10-09`)[0];
  ev.addEmailReminder(0);
  env.ctx.syncReminders();
  assert.deepEqual(plain(ev.emails), []);
  assert.deepEqual(plain(ev.popups), [0, 60]);
});

test("v4.10: events go to the default calendar; old separate calendar's events are removed once", () => {
  const env = makeEnv({ nowIso: "2026-10-09T06:00", props: { CAL_ID: "old-cal" } });
  env.oldCalendar.createEvent("old summary", new Date("2026-10-09T21:00"), new Date("2026-10-09T21:15")).setTag("mb", "sum|2026-10-09");
  env.oldCalendar.createEvent("someone's own event", new Date("2026-10-09T10:00"), new Date("2026-10-09T11:00"));
  const id = add(env.ctx, { title: "Update expenses", date: "2026-10-09", repeat: "none" });
  env.ctx.syncReminders();

  assert.deepEqual(plain(env.oldEvents.map(e => e.title)), ["someone's own event"]);
  assert.equal(byKey(env.events, `cn|${id}|2026-10-09`).length, 1);
  assert.equal(env.props.CAL_ID, undefined);
  assert.equal(env.props.REM_READY, "on");
});

test("a sync books one trigger 11 minutes before the next reminder", () => {
  const env = makeEnv({ nowIso: "2026-10-09T10:00", props: { REM_READY: "on" } });
  add(env.ctx, { title: "Night", time: "21:00", repeat: "daily" });
  add(env.ctx, { title: "Noon", date: "2026-10-09", time: "12:30", repeat: "none" });
  env.ctx.syncReminders();
  env.ctx.syncReminders();
  const lead = env.triggers.filter(t => t.handler === "remindersLeadSync");
  assert.equal(lead.length, 1);
  assert.equal(hm(lead[0].spec.at), "2026-10-09 12:19");
});

test("remindersLeadSync refreshes the amount, then books the next one", () => {
  const sheets = oct26();
  const env = makeEnv({ nowIso: "2026-10-09T20:49", sheets, props: { REM_READY: "on" } });
  const id = add(env.ctx, { type: "today_spend", title: "Today spent", userName: "suresh", time: "21:00", repeat: "daily" });
  env.ctx.syncReminders();
  sheets.Oct26.push(["a7", "2026-10-09", "suresh", "Expense", "Food", 30, "", ""]);
  env.ctx.remindersLeadSync();
  assert.equal(byKey(env.events, `cn|${id}|2026-10-09`)[0].title, "Today spent ₹400");
  const lead = env.triggers.filter(t => t.handler === "remindersLeadSync");
  assert.equal(lead.length, 1);
  assert.equal(hm(lead[0].spec.at), "2026-10-10 20:49");   // today's 20:49 has passed
});

test("no lead trigger for times already inside the 11 minutes or for silent events", () => {
  const env = makeEnv({ nowIso: "2026-10-09T20:50", props: { REM_READY: "on" } });
  env.ctx.computeFinance = () => [{ id: "p1", name: "Yog", userName: "", pending: 0, rows: [
    { month: "2026-10", dueDate: "2026-10-09", received: "Yes", interest: 6000, collected: 6000 }] }];
  add(env.ctx, { type: "loan", title: "Loans", time: "23:00" });   // only a "received" event (no popup)
  add(env.ctx, { title: "Soon", date: "2026-10-09", time: "21:00", repeat: "none" });
  env.ctx.syncReminders();
  assert.equal(env.triggers.filter(t => t.handler === "remindersLeadSync").length, 0);
});
