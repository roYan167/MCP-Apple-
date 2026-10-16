/**
 * Expands an iCalendar RRULE (as returned by Calendar.app's `recurrence`
 * property, e.g. "FREQ=WEEKLY;INTERVAL=1" or "FREQ=MONTHLY;BYDAY=2TU;UNTIL=20271231T225959Z")
 * into the concrete start dates that fall into [rangeStart, rangeEnd).
 *
 * IMPORTANT: this function is injected into the generated JXA script via
 * `expandRecurrence.toString()` (see tools/calendar.ts). It therefore has to be
 * completely self-contained: no imports, no references to anything outside its
 * own body, and nothing that the TypeScript compiler would turn into a helper
 * function (no spread of iterables, no class fields, ...).
 *
 * Occurrences keep the local wall-clock time of `firstStart` (so a series at
 * 17:00 stays at 17:00 across daylight-saving changes).
 *
 * Supported: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, COUNT, UNTIL, WKST,
 * BYDAY (with optional ordinals like 2TU / -1FR), BYMONTHDAY, BYMONTH, BYSETPOS.
 * Anything else (e.g. FREQ=HOURLY) is reported via `unsupported`.
 */
export function expandRecurrence(
  rule: string,
  firstStart: Date,
  rangeStart: Date,
  rangeEnd: Date,
  maxResults: number
): { dates: Date[]; unsupported?: string } {
  const parts: { [key: string]: string } = {};
  rule
    .replace(/^RRULE:/i, "")
    .split(";")
    .forEach(function (p) {
      const eq = p.indexOf("=");
      if (eq > 0) parts[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
    });

  const freq = parts["FREQ"];
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") {
    return { dates: [], unsupported: "FREQ=" + freq };
  }

  const interval = Math.max(1, parseInt(parts["INTERVAL"] || "1", 10) || 1);
  const count = parts["COUNT"] ? parseInt(parts["COUNT"], 10) : Infinity;

  let until = Infinity;
  if (parts["UNTIL"]) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(parts["UNTIL"]);
    if (m) {
      const y = parseInt(m[1] as string, 10);
      const mo = parseInt(m[2] as string, 10) - 1;
      const d = parseInt(m[3] as string, 10);
      if (m[4] === undefined) {
        until = new Date(y, mo, d, 23, 59, 59, 999).getTime(); // date only: whole day
      } else {
        const h = parseInt(m[4], 10);
        const mi = parseInt(m[5] as string, 10);
        const s = parseInt(m[6] as string, 10);
        until = m[7] ? Date.UTC(y, mo, d, h, mi, s) : new Date(y, mo, d, h, mi, s).getTime();
      }
    }
  }

  const DAYS: { [key: string]: number } = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const byday: { ord: number; day: number }[] = [];
  (parts["BYDAY"] ? parts["BYDAY"].split(",") : []).forEach(function (item) {
    const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(item.trim());
    if (m) byday.push({ ord: m[1] ? parseInt(m[1], 10) : 0, day: DAYS[(m[2] as string).toUpperCase()] as number });
  });
  function ints(key: string): number[] {
    return (parts[key] ? parts[key].split(",") : [])
      .map(function (v) {
        return parseInt(v, 10);
      })
      .filter(function (v) {
        return !isNaN(v);
      });
  }
  const bymonthday = ints("BYMONTHDAY");
  const bymonth = ints("BYMONTH");
  const bysetpos = ints("BYSETPOS");
  const wkst = parts["WKST"] && DAYS[parts["WKST"].toUpperCase()] !== undefined ? (DAYS[parts["WKST"].toUpperCase()] as number) : 1;

  const fy = firstStart.getFullYear();
  const fm = firstStart.getMonth();
  const fd = firstStart.getDate();
  const hh = firstStart.getHours();
  const mm = firstStart.getMinutes();
  const ss = firstStart.getSeconds();
  const ms = firstStart.getMilliseconds();

  // Same wall-clock time as the first occurrence, on the given (normalised) date.
  function mk(y: number, m: number, d: number): Date {
    return new Date(y, m, d, hh, mm, ss, ms);
  }
  function daysInMonth(y: number, m: number): number {
    return new Date(y, m + 1, 0).getDate();
  }

  // Day numbers within one month that the rule selects, ascending.
  function monthDays(y: number, m: number): number[] {
    const dim = daysInMonth(y, m);
    let days: number[] = [];
    if (bymonthday.length > 0) {
      bymonthday.forEach(function (md) {
        const d = md > 0 ? md : dim + md + 1;
        if (d >= 1 && d <= dim) days.push(d);
      });
      if (byday.length > 0) {
        days = days.filter(function (d) {
          const dow = new Date(y, m, d).getDay();
          return byday.some(function (b) {
            return b.day === dow;
          });
        });
      }
    } else if (byday.length > 0) {
      byday.forEach(function (b) {
        const list: number[] = [];
        for (let d = 1; d <= dim; d++) {
          if (new Date(y, m, d).getDay() === b.day) list.push(d);
        }
        if (b.ord === 0) {
          list.forEach(function (d) {
            days.push(d);
          });
        } else {
          const idx = b.ord > 0 ? b.ord - 1 : list.length + b.ord;
          const hit = list[idx];
          if (hit !== undefined) days.push(hit);
        }
      });
    } else if (fd <= dim) {
      days.push(fd);
    }
    days = days
      .filter(function (d, i) {
        return days.indexOf(d) === i;
      })
      .sort(function (a, b) {
        return a - b;
      });
    if (bysetpos.length > 0) {
      const all = days;
      days = [];
      bysetpos.forEach(function (p) {
        const hit = all[p > 0 ? p - 1 : all.length + p];
        if (hit !== undefined) days.push(hit);
      });
      days.sort(function (a, b) {
        return a - b;
      });
    }
    return days;
  }

  const results: Date[] = [];
  const firstTs = firstStart.getTime();
  const rangeStartTs = rangeStart.getTime();
  const rangeEndTs = rangeEnd.getTime();
  let produced = 0;

  // Returns false once nothing further can be produced.
  function accept(d: Date): boolean {
    const t = d.getTime();
    if (t < firstTs) return true;
    if (t > until || produced >= count) return false;
    produced++;
    if (t >= rangeStartTs && t < rangeEndTs) {
      results.push(d);
      if (results.length >= maxResults) return false;
    }
    return true;
  }

  const monthAllowed = function (month0: number): boolean {
    return bymonth.length === 0 || bymonth.indexOf(month0 + 1) !== -1;
  };

  for (let k = 0; k < 200000; k++) {
    let periodStart: Date;
    let candidates: Date[] = [];

    if (freq === "DAILY") {
      const day = mk(fy, fm, fd + k * interval);
      periodStart = day;
      const dow = day.getDay();
      const dayOk =
        byday.length === 0 ||
        byday.some(function (b) {
          return b.day === dow;
        });
      if (dayOk && monthAllowed(day.getMonth())) candidates.push(day);
    } else if (freq === "WEEKLY") {
      const backToWeekStart = (firstStart.getDay() - wkst + 7) % 7;
      const ws = mk(fy, fm, fd - backToWeekStart + k * 7 * interval);
      periodStart = ws;
      const wanted =
        byday.length > 0
          ? byday.map(function (b) {
              return b.day;
            })
          : [firstStart.getDay()];
      wanted.forEach(function (dow) {
        const offset = (dow - wkst + 7) % 7;
        const d = mk(ws.getFullYear(), ws.getMonth(), ws.getDate() + offset);
        if (monthAllowed(d.getMonth())) candidates.push(d);
      });
    } else if (freq === "MONTHLY") {
      const base = new Date(fy, fm + k * interval, 1);
      periodStart = base;
      if (monthAllowed(base.getMonth())) {
        monthDays(base.getFullYear(), base.getMonth()).forEach(function (d) {
          candidates.push(mk(base.getFullYear(), base.getMonth(), d));
        });
      }
    } else {
      const y = fy + k * interval;
      periodStart = new Date(y, 0, 1);
      const months =
        bymonth.length > 0
          ? bymonth
              .map(function (m) {
                return m - 1;
              })
              .sort(function (a, b) {
                return a - b;
              })
          : [fm];
      months.forEach(function (m) {
        monthDays(y, m).forEach(function (d) {
          candidates.push(mk(y, m, d));
        });
      });
    }

    if (periodStart.getTime() >= rangeEndTs && k > 0) break;
    candidates = candidates.sort(function (a, b) {
      return a.getTime() - b.getTime();
    });
    let keepGoing = true;
    for (let i = 0; i < candidates.length; i++) {
      if (!accept(candidates[i] as Date)) {
        keepGoing = false;
        break;
      }
    }
    if (!keepGoing) break;
  }

  return { dates: results };
}
