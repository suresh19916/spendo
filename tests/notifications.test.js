// Tests for the custom reminders (Reminders tab) in Code.gs.
// Run: npm test
const test   = require("node:test");
const assert = require("node:assert/strict");
const { makeEnv, hm, byKey } = require("./gas-env");

const NHEAD = ["ID", "UserName", "Title", "Date", "Time", "Repeat", "Active", "Note", "CreatedAt", "Type", "Completed On", "Notify Before (min)"];

// Arrays from the vm context have another realm's prototype — copy before deepEqual
const plain = v => JSON.parse(JSON.stringify(v));

function dates(ctx, repeat, date, from, to) {
  return plain(ctx.notifyDates({ repeat, date }, from, to));
}

test("notifyDates: once / daily / weekly", () => {
  const { ctx } = makeEnv({ nowIso: "2026-10-09T06:00" });
  assert.deepEqual(dates(ctx, "none", "2026-10-12", "2026-10-09", "2026-11-09"), ["2026-10-12"]);
  assert.deepEqual(dates(ctx, "none", "2026-10-01", "2026-10-09", "2026-11-09"), []);
  assert.deepEqual(dates(ctx, "daily", "2026-01-01", "2026-10-09", "2026-10-12"),
    ["2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12"]);
  assert.deepEqual(dates(ctx, "weekly", "2026-10-02", "2026-10-09", "2026-10-31"),
    ["2026-10-09", "2026-10-16", "2026-10-23", "2026-10-30"]);
  // Not started yet
  assert.deepEqual(dates(ctx, "daily", "2026-10-20", "2026-10-09", "2026-10-21"), ["2026-10-20", "2026-10-21"]);
});

test("notifyDates: monthly clamps to the month's last day, yearly keeps the date", () => {
  const { ctx } = makeEnv({ nowIso: "2026-10-09T06:00" });
  assert.deepEqual(dates(ctx, "monthly", "2026-01-31", "2026-01-01", "2026-05-31"),
    ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
  assert.deepEqual(dates(ctx, "monthly", "2025-03-15", "2026-10-09", "2026-12-31"),
    ["2026-10-15", "2026-11-15", "2026-12-15"]);
  assert.deepEqual(dates(ctx, "yearly", "2020-11-05", "2026-10-09", "2028-01-01"), ["2026-11-05", "2027-11-05"]);
});

test("saveNotification adds a row, validates input and returns the user's list", () => {
  const env = makeEnv({ nowIso: "2026-10-09T10:00" });
  const ctx = env.ctx;
  assert.match(ctx.saveNotification({ title: "", date: "2026-10-10", time: "09:00" }).error, /title/);
  assert.match(ctx.saveNotification({ title: "X", date: "10/10/2026", time: "09:00" }).error, /date/);
  assert.match(ctx.saveNotification({ title: "X", date: "2026-10-10", time: "25:00" }).error, /time/);
  assert.match(ctx.saveNotification({ title: "X", date: "2026-10-10", time: "09:00", repeat: "hourly" }).error, /repeat/);

  const res = ctx.saveNotification({ title: "Pay rent", date: "2026-10-05", time: "9:30", repeat: "monthly",
                                     note: "Owner UPI", userName: "suresh", listUser: "suresh" });
  assert.equal(res.success, true);
  assert.equal(res.notifications.length, 1);
  const n = res.notifications[0];
  assert.equal(n.time, "09:30");
  assert.equal(n.next, "2026-11-05 09:30");

  const rows = env.sheets.Notifications;
  assert.deepEqual(plain(rows[0]), NHEAD);
  assert.deepEqual(plain(rows[1].slice(1, 8)), ["suresh", "Pay rent", "2026-10-05", "09:30", "monthly", "Yes", "Owner UPI"]);

  // Another user's reminder is not in suresh's list
  const other = ctx.saveNotification({ title: "Gym", date: "2026-10-10", time: "06:00", userName: "ravi", listUser: "suresh" });
  assert.equal(other.notifications.length, 1);
  assert.equal(ctx.getNotifications({ userName: "" }).notifications.length, 2);
});

test("update and delete by id", () => {
  const env = makeEnv({ nowIso: "2026-10-09T10:00" });
  const ctx = env.ctx;
  const id = ctx.saveNotification({ title: "A", date: "2026-10-10", time: "08:00", userName: "u" }).id;
  const up = ctx.saveNotification({ id, title: "B", date: "2026-10-11", time: "21:15", repeat: "weekly", active: "No" });
  assert.equal(up.success, true);
  const n = ctx.getNotifications({}).notifications[0];
  assert.equal(n.title, "B");
  assert.equal(n.repeat, "weekly");
  assert.equal(n.active, "No");
  assert.equal(n.userName, "u");
  assert.equal(n.next, "");   // off → never fires

  assert.equal(ctx.saveNotification({ id: "nope", title: "C", date: "2026-10-11", time: "08:00" }).success, false);
  assert.equal(ctx.deleteNotification({ id: "nope" }).success, false);
  assert.equal(ctx.deleteNotification({ id }).success, true);
  assert.equal(ctx.getNotifications({}).notifications.length, 0);
  assert.equal(env.sheets.Notifications.length, 1);   // header only
});

test("list: upcoming first, soonest on top; next skips today's time once passed; fired one-time ones hidden", () => {
  const env = makeEnv({ nowIso: "2026-10-09T10:00" });
  const ctx = env.ctx;
  ctx.saveNotification({ title: "Later", date: "2026-10-20", time: "09:00" });
  ctx.saveNotification({ title: "Past", date: "2026-10-01", time: "09:00" });
  ctx.saveNotification({ title: "Daily 9am", date: "2026-10-01", time: "09:00", repeat: "daily" });
  ctx.saveNotification({ title: "Today 9pm", date: "2026-10-09", time: "21:00" });
  const list = ctx.getNotifications({}).notifications;
  assert.deepEqual(plain(list.map(n => n.title)), ["Today 9pm", "Daily 9am", "Later"]);
  assert.equal(list[1].next, "2026-10-10 09:00");
});

test("saving queues a calendar sync once setupReminders has run", () => {
  const env = makeEnv({ nowIso: "2026-10-09T10:00", props: { REM_READY: "on" } });
  env.ctx.saveNotification({ title: "A", date: "2026-10-10", time: "08:00" });
  env.ctx.saveNotification({ title: "B", date: "2026-10-10", time: "08:00" });
  assert.equal(env.triggers.filter(t => t.handler === "syncRemindersSoon").length, 1);
});

test("syncReminders books each occurrence with popup, no email, and follows edits", () => {
  const env = makeEnv({ nowIso: "2026-10-09T10:00", props: { REM_READY: "on" } });
  const ctx = env.ctx;
  const id = ctx.saveNotification({ title: "Pay card bill", date: "2026-09-25", time: "19:30",
                                    repeat: "monthly", note: "HDFC" }).id;
  ctx.saveNotification({ title: "Water plants", date: "2026-10-09", time: "07:00", repeat: "daily" });
  ctx.syncReminders();

  const card = byKey(env.events, `cn|${id}|2026-10-25`);
  assert.equal(card.length, 1);
  assert.equal(card[0].title, "Pay card bill");
  assert.equal(card[0].desc, "HDFC");
  assert.equal(hm(card[0].start), "2026-10-25 19:30");
  assert.deepEqual(plain(card[0].popups), [0, 60]);
  assert.deepEqual(plain(card[0].emails), []);
  // 31-day window: Oct 25 only (Nov 25 is past 2026-11-09)
  assert.equal(env.events.filter(e => e.tags.mb.startsWith(`cn|${id}|`)).length, 1);
  // Daily: today .. today+31
  assert.equal(env.events.filter(e => e.title === "Water plants").length, 32);

  // Edit time → same event moved; switch off → events removed
  ctx.saveNotification({ id, title: "Pay card bill", date: "2026-09-25", time: "08:00", repeat: "monthly", note: "HDFC" });
  ctx.syncReminders();
  assert.equal(hm(byKey(env.events, `cn|${id}|2026-10-25`)[0].start), "2026-10-25 08:00");

  ctx.saveNotification({ id, title: "Pay card bill", date: "2026-09-25", time: "08:00", repeat: "monthly", active: "No" });
  ctx.syncReminders();
  assert.equal(env.events.filter(e => e.tags.mb.startsWith(`cn|${id}|`)).length, 0);
});

test("REMINDER_USER limits which custom reminders reach the calendar", () => {
  const env = makeEnv({ nowIso: "2026-10-09T10:00", props: { REM_READY: "on", REMINDER_USER: "suresh" } });
  env.ctx.saveNotification({ title: "Mine", date: "2026-10-12", time: "08:00", userName: "suresh" });
  env.ctx.saveNotification({ title: "Theirs", date: "2026-10-12", time: "08:00", userName: "ravi" });
  env.ctx.syncReminders();
  assert.deepEqual(env.events.map(e => e.title), ["Mine"]);
});

test("hand-typed sheet values (Date objects, time cells) are read back", () => {
  const env = makeEnv({ nowIso: "2026-10-09T10:00", sheets: { Notifications: [NHEAD,
    ["x1", "u", "Typed", new Date("2026-10-15T00:00"), new Date("1899-12-30T18:45"), "Weekly", "", "", ""]] } });
  const n = env.ctx.getNotifications({}).notifications[0];
  assert.equal(n.date, "2026-10-15");
  assert.equal(n.time, "18:45");
  assert.equal(n.repeat, "weekly");
  assert.equal(n.active, "Yes");
});

test("type is validated; loan / chit ignore date and repeat", () => {
  const { ctx } = makeEnv({ nowIso: "2026-10-09T10:00" });
  assert.match(ctx.saveNotification({ type: "sms", title: "X", date: "2026-10-10", time: "09:00" }).error, /type/);
  const res = ctx.saveNotification({ type: "loan", title: "Loans", time: "08:00", repeat: "daily", userName: "u" });
  assert.equal(res.success, true);
  const n = res.notifications[0];
  assert.equal(n.type, "loan");
  assert.equal(n.repeat, "none");
  assert.equal(n.date, "2026-10-09");
  assert.equal(n.next, "");
});

test("pre-v4.8 rows without a Type column read as text, and the header gains Type on save", () => {
  const env = makeEnv({ nowIso: "2026-10-09T10:00", sheets: { Notifications: [NHEAD.slice(0, 9),
    ["x1", "u", "Old", "2026-10-15", "08:00", "none", "Yes", "", ""]] } });
  assert.equal(env.ctx.getNotifications({}).notifications[0].type, "text");
  env.ctx.saveNotification({ title: "New", date: "2026-10-16", time: "08:00" });
  assert.deepEqual(plain(env.sheets.Notifications[0]), NHEAD);
  assert.equal(env.sheets.Notifications[1][9], "text");
  assert.equal(env.sheets.Notifications[0][10], "Completed On");
});

test("addDefaultNotifications adds the six defaults once per user", () => {
  const env = makeEnv({ nowIso: "2026-10-09T10:00" });
  const res = env.ctx.addDefaultNotifications({ userName: "suresh", listUser: "suresh" });
  assert.equal(res.success, true);
  assert.deepEqual(plain(res.notifications.map(n => n.type).sort()),
    ["chit", "last_month", "loan", "month_spend", "text", "today_spend"]);
  assert.ok(res.notifications.every(n => n.userName === "suresh" && n.active === "Yes"));

  const ts = res.notifications.find(n => n.type === "today_spend");
  assert.equal(ts.next, "2026-10-09 21:00");
  const ms = res.notifications.find(n => n.type === "month_spend");
  assert.equal(ms.next, "2026-10-31 21:00");   // last day of the month
  const lm = res.notifications.find(n => n.type === "last_month");
  assert.equal(lm.next, "2026-11-01 09:00");

  // Second call adds nothing; another user gets their own set
  assert.equal(env.ctx.addDefaultNotifications({ userName: "suresh", listUser: "suresh" }).notifications.length, 6);
  assert.equal(env.ctx.addDefaultNotifications({ userName: "ravi", listUser: "" }).notifications.length, 12);
});

test("completeNotifications marks fired one-time reminders in the sheet, keeps the rows", () => {
  const env = makeEnv({ nowIso: "2026-10-09T21:10" });
  const ctx = env.ctx;
  const fired  = ctx.saveNotification({ title: "Fired",  date: "2026-10-09", time: "21:00" }).id;
  const later  = ctx.saveNotification({ title: "Later",  date: "2026-10-09", time: "22:00" }).id;
  const daily  = ctx.saveNotification({ title: "Daily",  date: "2026-10-01", time: "09:00", repeat: "daily" }).id;
  const off    = ctx.saveNotification({ title: "Off",    date: "2026-10-01", time: "09:00", active: "No" }).id;
  const loan   = ctx.saveNotification({ type: "loan", title: "Loans", time: "09:00" }).id;
  ctx.completeNotifications();

  const row = id => env.sheets.Notifications.find(r => r[0] === id);
  assert.equal(row(fired)[10], "2026-10-09 21:10");
  for (const id of [later, daily, off, loan]) assert.equal(row(id)[10], "");
  assert.equal(env.sheets.Notifications.length, 6);   // header + all 5 rows kept

  assert.deepEqual(plain(ctx.getNotifications({}).notifications.map(n => n.title).sort()),
    ["Daily", "Later", "Loans", "Off"]);
});

test("refreshReminderAmounts (30-min trigger) completes reminders even before setup", () => {
  const env = makeEnv({ nowIso: "2026-10-09T21:10" });
  const id = env.ctx.saveNotification({ title: "Fired", date: "2026-10-09", time: "21:00" }).id;
  env.ctx.refreshReminderAmounts();
  assert.equal(env.sheets.Notifications.find(r => r[0] === id)[10], "2026-10-09 21:10");
});

test("editing a completed reminder to a later date brings it back", () => {
  const env = makeEnv({ nowIso: "2026-10-09T21:10" });
  const ctx = env.ctx;
  const id = ctx.saveNotification({ title: "Again", date: "2026-10-09", time: "21:00" }).id;
  ctx.completeNotifications();
  const res = ctx.saveNotification({ id, title: "Again", date: "2026-10-12", time: "21:00" });
  assert.equal(res.notifications[0].next, "2026-10-12 21:00");
  assert.equal(env.sheets.Notifications[1][10], "");
});

test("getNotifications tells the app which Google account gets the alerts", () => {
  const env = makeEnv({ nowIso: "2026-10-09T10:00" });
  assert.equal(env.ctx.getNotifications({}).calendarOwner, "owner@example.com");
});

test("Notify Before: default 1 hour, choosable, stored in the sheet, old rows read as 1 hour", () => {
  const env = makeEnv({ nowIso: "2026-10-09T10:00", props: { REM_READY: "on" } });
  const ctx = env.ctx;
  const a = ctx.saveNotification({ title: "Default", date: "2026-10-10", time: "08:00" }).id;
  const b = ctx.saveNotification({ title: "At time", date: "2026-10-10", time: "08:00", before: "0" }).id;
  const c = ctx.saveNotification({ title: "Day", date: "2026-10-10", time: "08:00", before: "1440" }).id;
  const d = ctx.saveNotification({ title: "Odd", date: "2026-10-10", time: "08:00", before: "45" }).id;
  ctx.syncReminders();
  const pops = id => plain(env.events.find(e => e.tags.mb === `cn|${id}|2026-10-10`).popups).sort((x, y) => x - y);
  assert.deepEqual(pops(a), [0, 60]);
  assert.deepEqual(pops(b), [0]);
  assert.deepEqual(pops(c), [0, 1440]);
  assert.deepEqual(pops(d), [0, 60]);   // not an offered choice → default
  const row = id => env.sheets.Notifications.find(r => r[0] === id);
  assert.equal(row(b)[11], "0");
  assert.equal(ctx.getNotifications({}).notifications.find(n => n.id === c).before, 1440);

  const old = makeEnv({ nowIso: "2026-10-09T10:00", sheets: { Notifications: [NHEAD.slice(0, 11),
    ["x1", "u", "Old", "2026-10-15", "08:00", "none", "Yes", "", "", "text", ""]] } });
  assert.equal(old.ctx.getNotifications({}).notifications[0].before, 60);
});

test("loan dues with Notify Before = 1 day don't get a duplicate day-before popup", () => {
  const env = makeEnv({ nowIso: "2026-10-09T06:00", props: { REM_READY: "on" } });
  env.ctx.computeFinance = () => [{ id: "p1", name: "Yog", userName: "", pending: 0, rows: [
    { month: "2026-10", dueDate: "2026-10-12", received: "No", interest: 6000, collected: 0 }] }];
  const id = env.ctx.saveNotification({ type: "loan", title: "Loans", time: "09:00", before: "1440" }).id;
  env.ctx.syncReminders();
  assert.deepEqual(plain(env.events.find(e => e.tags.mb === `cn|${id}|p1|2026-10`).popups), [0, 1440]);
});
