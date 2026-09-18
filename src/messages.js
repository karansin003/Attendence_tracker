/**
 * Shared message builders (watcher + scheduler use these; Telegram pe jaate hain).
 */
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

/** 'Thu, 11 Sep 2026' in IST */
function dateLabelIST(d = new Date()) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

function statusEmoji(status, raw) {
  if (status === 'present') return '✅ Present';
  if (status === 'absent') return '❌ Absent';
  return `ℹ️ ${norm(raw) || 'Marked'}`;
}

/**
 * Per-class alert — spec: teacher name + marked you as present/absent +
 * subject + date (kis din ka). Room timetable enrichment se aata hai (optional).
 */
function formatAttendanceUpdate(row, dateLabel = dateLabelIST()) {
  const lines = [
    `📌 *Attendance Update* — ${dateLabel}`,
    `Teacher: ${row.employee || '—'}`,
    `Subject: ${row.subject} (${row.subjectCode})`,
    `Period: ${row.period} (${row.duration})`,
  ];
  if (row.room) lines.push(`Room: ${row.room}`);
  lines.push(`${row.employee || 'Teacher'} marked you as: ${statusEmoji(row.status, row.attendance)}`);
  return lines.join('\n');
}

/**
 * Morning schedule (roz 8:30 AM IST): aaj ki saari classes + time + room + teacher.
 */
function formatMorningSchedule(rows, dateLabel = dateLabelIST()) {
  const list = (rows || []).filter((r) => r.period || r.subject);
  const lines = [`🌅 *Aaj ki Classes* — ${dateLabel}`, ''];
  if (!list.length) {
    lines.push('🎉 Aaj koi class schedule nahi hai. Enjoy!');
  } else if (list.some((r) => 'room' in r)) {
    // Timetable mode — period time + ROOM + teacher available hai
    list.forEach((r, i) => {
      lines.push(`${i + 1}. 🕐 *${r.duration || r.period}* — ${r.subject}${r.subjectCode ? ` (${r.subjectCode})` : ''}`);
      const extras = [];
      if (r.room) extras.push(`Room: ${r.room}`);
      if (r.teacher) extras.push(r.teacher);
      if (extras.length) lines.push(`    ${extras.join(' • ')}`);
    });
    lines.push('');
    lines.push('_Marks lagte hi turant attendance update milega 📲_');
  } else {
    // Attendance-rows mode (fallback — isme room nahi hota)
    list.forEach((r, i) => {
      lines.push(`${i + 1}. *${r.period}* (${r.duration})`);
      lines.push(`    ${r.subject} (${r.subjectCode}) — ${r.employee || 'TBA'}`);
    });
    lines.push('');
    lines.push('_Marks lagte hi turant attendance update milega 📲_');
  }
  return lines.join('\n');
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' -> '12 Sep 2026' (civil date — TZ-independent label). */
function dateLabelFromYMD(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(ymd || '');
  return `${m[3]} ${MONTHS_SHORT[Number(m[2]) - 1] || '?'} ${m[1]}`;
}

/**
 * Backdated month-register alert — spec format:
 *   📌 Attendance Update
 *   {Teacher} ne {Date} ko {Subject} ({Code}) ka attendance mark kiya
 *   Status: ✅ Present / ❌ Absent
 */
function formatBackdatedUpdate(rec) {
  const lines = [
    '📌 *Attendance Update*',
    `${rec.teacher || 'Teacher'} ne ${dateLabelFromYMD(rec.date)} ko ${rec.subject || rec.subjectCode} (${rec.subjectCode}) ka attendance mark kiya`,
  ];
  if (rec.room) lines.push(`Room: ${rec.room}`);
  if ((rec.lectures || []).length > 1) {
    // Ek hi din me 2+ lectures (portal "P,A" jaisa cell) — per-lecture status
    lines.push(`Status: ${rec.lectures.map((l, i) => `L${i + 1} ${statusEmoji(l.status, l.statusRaw)}`).join(' | ')}`);
  } else {
    lines.push(`Status: ${statusEmoji(rec.status, rec.statusRaw)}`);
  }
  return lines.join('\n');
}

/**
 * 9 PM-style attendance summary message (pehle whatsapp.js me tha — ab shared
 * builder, Telegram se bheja jata hai).
 */
function formatAttendanceMessage(analysis) {
  const lines = [];
  lines.push('*\u{1F4CA} QUMS Attendance Report*');
  const stamp = new Date(analysis.generatedAt).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  lines.push(`_${stamp} (IST)_`);
  lines.push('');
  for (const s of analysis.subjects) {
    const emoji = s.status === 'below-75' ? '\u26A0\uFE0F' : '\u2705';
    lines.push(`${emoji} *${s.subject}*${s.subjectCode ? ` (${s.subjectCode})` : ''}: ${s.percentage}%`);
    lines.push(`     ${s.guidance}`);
  }
  lines.push('');
  lines.push(
    `Subjects: ${analysis.summary.totalSubjects} | Below 75%: ${analysis.summary.below75} | Status: ${analysis.summary.overallStatus}`
  );
  if (analysis.demoData) {
    lines.push('_(DEMO data — live scrape nahi hua)_');
  }
  lines.push('_Auto-sent by QUMS Attendance Bot \u{1F916}_');
  return lines.join('\n');
}

module.exports = { dateLabelIST, dateLabelFromYMD, statusEmoji, formatAttendanceUpdate, formatBackdatedUpdate, formatMorningSchedule, formatAttendanceMessage, norm };
