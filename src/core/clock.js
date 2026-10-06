'use strict';

// The scenario clock: maps real time onto the company's operating year.
// It shifts by a whole number of weeks, so weekdays and times of day stay in step
// with the real clock (working hours, "Monday morning" etc. still line up) and
// the date lands within a few days of the same calendar date in that year.

const DAY = 86400000;
const WEEK = 7 * DAY;
const MIN_YEAR = 1980;
const MAX_YEAR = 2100;

function validYear(year) {
  const y = Number(year);
  return Number.isInteger(y) && y >= MIN_YEAR && y <= MAX_YEAR ? y : null;
}

// Milliseconds to subtract from real time (whole weeks). 0 when no operating year is set.
// Chosen so that "now" lands inside the operating year itself, even near New Year.
function offsetMs(year, now = new Date()) {
  const y = validYear(year);
  if (!y) return 0;
  let weeks = Math.round(((now.getFullYear() - y) * 365.2425) / 7);
  const yearAt = (w) => new Date(now.getTime() - w * WEEK).getFullYear();
  while (yearAt(weeks) < y) weeks--;
  while (yearAt(weeks) > y) weeks++;
  return weeks * WEEK;
}

function toScenario(date, year, now = new Date()) {
  const d = new Date(date);
  const t = new Date(d.getTime() - offsetMs(year, now));
  // Daylight-saving changes fall on different dates in different years; keep the
  // same wall-clock time as the real clock.
  return new Date(t.getTime() + (t.getTimezoneOffset() - d.getTimezoneOffset()) * 60000);
}

function formatScenario(date, year) {
  return toScenario(date, year).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' });
}

module.exports = { offsetMs, toScenario, formatScenario, validYear, MIN_YEAR, MAX_YEAR };
