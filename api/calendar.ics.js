// Serves a per-teacher ICS/webcal feed of their open tasks (Task List, Monthly
// Calendar, Personal Planner all write to the same DB.tasks collection), so a
// teacher can subscribe once in Google/Apple/Outlook and get real device alerts
// even when Teacher Command Center itself isn't open.
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

    lines.push('END:VCALENDAR');

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=900');
    res.status(200).send(lines.join('\r\n'));
  } catch (err) {
    res.status(500).send('Error generating calendar feed: ' + (err && err.message ? err.message : 'unknown error'));
  }
};
