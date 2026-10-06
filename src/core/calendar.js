'use strict';

// Meeting invitations (iCalendar, RFC 5545 / iTIP RFC 5546). Sent as a
// text/calendar; method=REQUEST part so mail clients show a real invitation with
// Accept / Decline buttons, and responses (method=REPLY) are recognised on the way in.

const crypto = require('crypto');

const pad = (n) => String(n).padStart(2, '0');
const utc = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
const escText = (t) => String(t || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const escParam = (t) => `"${String(t || '').replace(/"/g, "'")}"`;

// Lines longer than 75 octets are folded with CRLF + space (RFC 5545 §3.1).
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + (start === 0 ? 75 : 74), bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--; // don't split UTF-8 characters
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
  }
  return parts.join('\r\n ');
}

/**
 * Parse the AI's proposal: { title, start: "YYYY-MM-DDTHH:MM" (scenario local time),
 * durationMinutes, location, notes }. The start is moved into the scenario year if the
 * model got the year wrong, and must be in the (scenario) future.
 */
function normaliseMeeting(m, scenarioNow) {
  if (!m || typeof m !== 'object' || !m.title || !m.start) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(m.start));
  if (!match) return null;
  const [, , mo, d, h, mi] = match.map(Number);
  let start = new Date(scenarioNow.getFullYear(), mo - 1, d, h, mi);
  if (Number.isNaN(start.getTime())) return null;
  if (start <= scenarioNow) start = new Date(start.getFullYear() + 1, mo - 1, d, h, mi);
  if (start - scenarioNow > 120 * 86400000) return null; // more than four months out: ignore
  const duration = Math.min(480, Math.max(15, Math.round(Number(m.durationMinutes) || 60)));
  return {
    title: String(m.title).slice(0, 120),
    start,
    durationMinutes: duration,
    location: String(m.location || '').slice(0, 160),
    notes: String(m.notes || '').slice(0, 1000),
  };
}

// prodId identifies the sending client, e.g. "-//Microsoft Corporation//Outlook 11.0 MIMEDIR//EN".
function invite({ meeting, organizer, attendees, prodId, stamp = new Date(), uid }) {
  const end = new Date(meeting.start.getTime() + meeting.durationMinutes * 60000);
  const id = uid || `${crypto.randomUUID().replace(/-/g, '').toUpperCase()}@${organizer.email.split('@')[1]}`;
  const lines = [
    'BEGIN:VCALENDAR',
    `PRODID:${prodId || '-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN'}`,
    'VERSION:2.0',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${id}`,
    `DTSTAMP:${utc(stamp)}`,
    `DTSTART:${utc(meeting.start)}`,
    `DTEND:${utc(end)}`,
    `SUMMARY:${escText(meeting.title)}`,
    ...(meeting.location ? [`LOCATION:${escText(meeting.location)}`] : []),
    ...(meeting.notes ? [`DESCRIPTION:${escText(meeting.notes)}`] : []),
    `ORGANIZER;CN=${escParam(organizer.name)}:mailto:${organizer.email}`,
    ...attendees.map((a) => `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=${escParam(a.name || a.email)}:mailto:${a.email}`),
    'SEQUENCE:0',
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'CLASS:PUBLIC',
    'PRIORITY:5',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:REMINDER',
    'TRIGGER:-PT15M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return { uid: id, ics: lines.map(fold).join('\r\n') + '\r\n' };
}

// Unfold and read a received calendar object (e.g. an Accept/Decline).
function parse(icsText) {
  const text = String(icsText || '').replace(/\r?\n[ \t]/g, '');
  const get = (re) => { const m = re.exec(text); return m ? m[1].trim() : ''; };
  return {
    method: get(/^METHOD:(.+)$/m).toUpperCase(),
    uid: get(/^UID:(.+)$/m),
    summary: get(/^SUMMARY[^:]*:(.+)$/m).replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, ' '),
    partstat: get(/^ATTENDEE[^:]*PARTSTAT=([A-Z-]+)/m).toUpperCase(),
    dtstart: get(/^DTSTART[^:]*:(.+)$/m),
  };
}

// Human description stored with the message and shown to the AI.
function describe(meeting) {
  const when = meeting.start.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `${meeting.title}, ${when} (${meeting.durationMinutes} min)${meeting.location ? `, ${meeting.location}` : ''}`;
}

module.exports = { invite, parse, normaliseMeeting, describe };
