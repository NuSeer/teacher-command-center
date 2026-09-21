// Serves a per-teacher ICS/webcal feed of their open tasks (Task List, Monthly
// Calendar, Personal Planner all write to the same DB.tasks collection), so a
// teacher can subscribe once in Google/Apple/Outlook and get real device alerts
// even when Teacher Command Center itself isn't open. With A/B days turned on it
// also carries an all-day "A Day" / "B Day" event per school day (with that day's
// schedule in the description).
//
// The feed URL is /api/calendar.ics?u=<teacherUid>&s=<calendarSecret>. There is no
// separate token-lookup collection: the uid comes straight from the URL, and this
// function (using the Firebase Admin SDK, which bypasses client security rules)
// fetches that teacher's own doc and checks the secret embedded there
// (teachers/{uid}/data/main.setup.calendarSecret) before returning anything.
// firebase-admin v10+ dropped the classic admin.initializeApp()/admin.credential.cert()
// namespaced API from the top-level `require('firebase-admin')` export — it's modular now.
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

function ensureApp() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  }
}

function icsEscape(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// RFC5545 requires folding any content line longer than 75 octets, continuation
// lines start with a single space.
function foldLine(line) {
  if (line.length <= 75) return line;
  var out = '';
  var first = true;
  var rest = line;
  while (rest.length > 0) {
    var chunkLen = first ? 75 : 74;
    out += (first ? '' : '\r\n ') + rest.slice(0, chunkLen);
    rest = rest.slice(chunkLen);
    first = false;
  }
  return out;
}

// ── A/B day labels ──────────────────────────────────────────────────────────
// Mirrors abDayFor() in index.html: the teacher pins one school day to A or B (setup.abAnchor) and the letter
// flips on every school day after/before it. Weekends and Holiday / No School / PD Day events don't count.
// Dates are handled as plain YYYY-MM-DD strings in UTC so the server's timezone can't shift a day.
function addDays(ds, n) {
  var d = new Date(ds + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isNoSchool(ds, events) {
  return events.some(function (e) {
    // end date is optional in the event form: no end = a single day
    return e && /holiday|no school|^pd day/i.test(e.type || '') && e.start && e.start <= ds && ds <= (e.end || e.start);
  });
}
function isSchoolDay(ds, events) {
  var w = new Date(ds + 'T12:00:00Z').getUTCDay();
  return w !== 0 && w !== 6 && !isNoSchool(ds, events);
}
function letterFor(ds, anchor, events) {
  if (!isSchoolDay(ds, events)) return '';
  var step = ds >= anchor.date ? 1 : -1;
  var d = anchor.date;
  var n = 0;
  for (var guard = 0; guard < 900 && d !== ds; guard++) {
    d = addDays(d, step);
    if (isSchoolDay(d, events)) n++;
  }
  return n % 2 === 0 ? anchor.day : anchor.day === 'A' ? 'B' : 'A';
}
function fmtTime(t) {
  var m = /^(\d{1,2}):(\d{2})/.exec(t || '');
  if (!m) return '';
  var h = parseInt(m[1], 10);
  var ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + m[2] + ' ' + ap;
}
function scheduleText(rows) {
  return (rows || [])
    .map(function (r) {
      var t = r.start && r.end ? fmtTime(r.start) + '–' + fmtTime(r.end) + '  ' : r.start ? fmtTime(r.start) + '  ' : '';
      return t + (r.label || '') + (r.subject ? ' (' + r.subject + ')' : '');
    })
    .join('\n');
}
// One all-day "A Day" / "B Day" event per school day: from 2 weeks back to the last day of school (or a year ahead).
function abDayEvents(setup, events, todayStr, stamp) {
  var out = [];
  var an = setup.abAnchor;
  if (!setup.abEnabled || !an || !an.date || (an.day !== 'A' && an.day !== 'B')) return out;
  var start = addDays(todayStr, -14);
  var maxEnd = addDays(todayStr, 450);
  var end = setup.lastday && setup.lastday >= todayStr ? setup.lastday : addDays(todayStr, 365);
  if (end > maxEnd) end = maxEnd;
  var prev = '';
  for (var ds = start; ds <= end; ds = addDays(ds, 1)) {
    if (!isSchoolDay(ds, events)) continue;
    var letter = prev ? (prev === 'A' ? 'B' : 'A') : letterFor(ds, an, events);
    prev = letter;
    var digits = ds.replace(/-/g, '');
    var rows = letter === 'B' ? setup.scheduleB : setup.schedule;
    var desc = letter + ' Day' + (rows && rows.length ? ' schedule\n' + scheduleText(rows) : '');
    out.push('BEGIN:VEVENT');
    out.push('UID:abday-' + ds + '@teachercommandcenter.app');
    out.push('DTSTAMP:' + stamp);
    out.push('DTSTART;VALUE=DATE:' + digits);
    out.push('DTEND;VALUE=DATE:' + addDays(ds, 1).replace(/-/g, ''));
    out.push(foldLine('SUMMARY:' + icsEscape(letter + ' Day')));
    out.push(foldLine('DESCRIPTION:' + icsEscape(desc)));
    out.push('TRANSP:TRANSPARENT');
    out.push('END:VEVENT');
  }
  return out;
}

module.exports = async (req, res) => {
  try {
    var u = req.query.u;
    var s = req.query.s;
    if (!u || !s) {
      res.status(400).send('Missing calendar link parameters.');
      return;
    }

    try {
      ensureApp();
    } catch (initErr) {
      res.status(500).send('Firebase init failed: ' + initErr.message);
      return;
    }
    var db = getFirestore();
    var doc;
    try {
      doc = await db.collection('teachers').doc(u).collection('data').doc('main').get();
    } catch (fsErr) {
      res.status(500).send('Firestore fetch failed: ' + fsErr.message);
      return;
    }
    if (!doc.exists) {
      res.status(404).send('Calendar not found.');
      return;
    }
    var data = doc.data() || {};
    var setup = data.setup || {};
    if (!setup.calendarSecret || setup.calendarSecret !== s) {
      res.status(403).send('Invalid or revoked calendar link.');
      return;
    }

    var tasks = (data.tasks || []).filter(function (t) {
      return t && t.due && !t.done;
    });

    var now = new Date();
    var stamp = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    var calName = (setup.teacher ? setup.teacher + ' — ' : '') + 'Teacher Tasks';

    var lines = [];
    lines.push('BEGIN:VCALENDAR');
    lines.push('VERSION:2.0');
    lines.push('PRODID:-//Teacher Command Center//Task Calendar//EN');
    lines.push('CALSCALE:GREGORIAN');
    lines.push('METHOD:PUBLISH');
    lines.push(foldLine('X-WR-CALNAME:' + icsEscape(calName)));
    lines.push('X-WR-TIMEZONE:UTC');
    lines.push('REFRESH-INTERVAL;VALUE=DURATION:PT2H');
    lines.push('X-PUBLISHED-TTL:PT2H');

    tasks.forEach(function (t) {
      var dateDigits = String(t.due).replace(/-/g, '');
      var uid = String(t.id || Math.random().toString(36).slice(2)) + '@teachercommandcenter.app';
      var personal = t.cat === 'Personal';
      var summary = (personal ? '🔒 ' : '') + (t.title || 'Task');
      var priorityNum = t.priority === 'High' ? 1 : t.priority === 'Low' ? 9 : 5;

      lines.push('BEGIN:VEVENT');
      lines.push(foldLine('UID:' + uid));
      lines.push('DTSTAMP:' + stamp);
      // Floating local time (no Z / TZID) at 8:00am on the due date, 30-minute block,
      // with a reminder 30 minutes beforehand — most calendar apps interpret a
      // floating time as the viewer's own device timezone.
      lines.push('DTSTART:' + dateDigits + 'T080000');
      lines.push('DTEND:' + dateDigits + 'T083000');
      lines.push(foldLine('SUMMARY:' + icsEscape(summary)));
      lines.push(foldLine('DESCRIPTION:' + icsEscape((t.cat || 'General') + ' task from Teacher Command Center')));
      lines.push('PRIORITY:' + priorityNum);
      lines.push('BEGIN:VALARM');
      lines.push('ACTION:DISPLAY');
      lines.push(foldLine('DESCRIPTION:' + icsEscape(summary)));
      lines.push('TRIGGER:-PT30M');
      lines.push('END:VALARM');
      lines.push('END:VEVENT');
    });

    // A/B day labels (only when the teacher has A/B days turned on and has set which day is A or B)
    abDayEvents(setup, data.calendarEvents || [], now.toISOString().slice(0, 10), stamp).forEach(function (l) {
      lines.push(l);
    });

    lines.push('END:VCALENDAR');

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=900');
    res.status(200).send(lines.join('\r\n'));
  } catch (err) {
    res.status(500).send('Error generating calendar feed: ' + (err && err.message ? err.message : 'unknown error'));
  }
};
