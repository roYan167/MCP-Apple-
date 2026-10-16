import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runJXAJson, toJXALiteral } from "../services/jxa.js";
import { expandRecurrence } from "../services/recurrence.js";
import { CalendarEvent, CalendarInfo, truncate } from "../types.js";
import { CHARACTER_LIMIT, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from "../constants.js";

// Calendars searched when neither calendar_name nor all_calendars is given.
// Calendar.app needs ~5ms per event, so large calendars can be made opt-in by
// listing only the everyday ones in the env var APPLE_MCP_DEFAULT_CALENDARS
// (comma-separated exact names, e.g. "Home,Work"). If it is unset or empty,
// every calendar is searched by default.
const DEFAULT_CALENDARS: string[] = (process.env.APPLE_MCP_DEFAULT_CALENDARS ?? "")
  .split(",")
  .map((n) => n.trim())
  .filter((n) => n.length > 0);
const DEFAULTS_LABEL = DEFAULT_CALENDARS.length > 0 ? DEFAULT_CALENDARS.join(", ") : "all calendars (APPLE_MCP_DEFAULT_CALENDARS not set)";

function textContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function registerCalendarTools(server: McpServer): void {
  server.registerTool(
    "calendar_list_calendars",
    {
      title: "List Calendars",
      description: `Lists every calendar available in the macOS Calendar app (e.g. "Home", "Work", a shared iCloud calendar).

Use this first to find the exact calendar name(s) to pass into calendar_list_events or calendar_create_event.

Returns: JSON array of { name: string, writable: boolean }.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      const script = `
        (function () {
          const app = Application('Calendar');
          app.includeStandardAdditions = true;
          const cals = app.calendars();
          const result = cals.map(function (c) {
            return { name: c.name(), writable: c.writable() };
          });
          return JSON.stringify(result);
        })()
      `;
      const calendars = await runJXAJson<CalendarInfo[]>(script);
      return {
        ...textContent(truncate(JSON.stringify(calendars, null, 2), CHARACTER_LIMIT)),
        structuredContent: { calendars }
      };
    }
  );

  const ListEventsInput = z
    .object({
      start_date: z.string().describe("Inclusive start of the range, ISO 8601, e.g. '2026-09-25' or '2026-09-25T00:00:00'"),
      end_date: z.string().describe("Exclusive end of the range, ISO 8601, e.g. '2026-10-02'"),
      calendar_name: z
        .string()
        .optional()
        .describe(
          `Only include events from this calendar (any calendar, exact name). Omit to search the default calendars: ${DEFAULTS_LABEL}.`
        ),
      all_calendars: z
        .boolean()
        .default(false)
        .describe("Search ALL calendars instead of only the default ones. Can be slow on large calendars (Calendar.app reads ~5ms per event)."),
      search_text: z
        .string()
        .optional()
        .describe("Only include events whose title contains this text (case-insensitive)."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIST_LIMIT)
        .default(DEFAULT_LIST_LIMIT)
        .describe(`Maximum events to return (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}).`)
    })
    .strict();

  server.registerTool(
    "calendar_list_events",
    {
      title: "List Calendar Events",
      description: `Lists events that start within [start_date, end_date), optionally filtered by calendar and/or title text.

Note: events are matched by their START time falling in the range. A multi-day event that starts before start_date but
overlaps the range will NOT be included - widen start_date if you need those too.

Recurring events (daily/weekly/monthly/yearly series) are expanded: every occurrence starting in the range is returned
as its own entry with "recurring": true, even if the series began long before start_date. All occurrences of a series
share the same "id" - calendar_update_event / calendar_delete_event on that id affects the WHOLE series.
Args:
  - start_date (string): inclusive range start, ISO 8601
  - end_date (string): exclusive range end, ISO 8601
  - calendar_name (string, optional): restrict to one calendar (any calendar, exact name)
  - all_calendars (boolean, optional): search every calendar, not just the defaults (${DEFAULTS_LABEL}); slow
  - search_text (string, optional): case-insensitive substring match on the event title
  - limit (number, optional): max results, default ${DEFAULT_LIST_LIMIT}

Returns: JSON array of events with { id, calendar, title, startDate, endDate, allDay, location, notes, recurring }.
Unsupported recurrence rules are reported in a trailing "Warnings:" section instead of being dropped silently.
The "id" is the event's stable uid - pass it to calendar_update_event / calendar_delete_event.

Error Handling:
  - Returns an empty array (not an error) if nothing matches.
  - Large ranges across big calendars can be slow (Calendar.app's own limitation) - prefer narrow ranges.`,
      inputSchema: ListEventsInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: z.infer<typeof ListEventsInput>) => {
      const script = `
        (function () {
          const app = Application('Calendar');
          const params = ${toJXALiteral(params)};
          const rangeStart = new Date(params.start_date);
          const rangeEnd = new Date(params.end_date);
          const wantedCalendar = params.calendar_name || null;
          const defaults = ${toJXALiteral(DEFAULT_CALENDARS)};
          const searchText = params.search_text ? params.search_text.toLowerCase() : null;
          const limit = params.limit;
          const expandRecurrence = ${expandRecurrence.toString()};

          const cals = app.calendars().filter(function (c) {
            const name = c.name();
            if (wantedCalendar) return name === wantedCalendar;
            if (params.all_calendars || defaults.length === 0) return true;
            return defaults.indexOf(name.trim()) !== -1;
          });

          // Performance: events.whose({startDate...}) makes Calendar.app scan
          // every event and took ~250s here. Reading ONE property for all
          // events of a calendar in bulk (~5ms/event) is ~8x faster, so we
          // fetch all start dates (and recurrence rules) in bulk, pick the
          // matching occurrences in the script and read the remaining
          // properties for the hits only. Reading a single event by index
          // costs ~1s, a bulk read ~5ms per event in the calendar, so with few
          // hits we read per event, with many in bulk.
          //
          // Recurring events: Calendar.app only returns the FIRST event of a
          // series (its startDate lies wherever the series began), never the
          // individual occurrences. So for every event that has a recurrence
          // rule we expand the rule ourselves and report each occurrence that
          // starts inside the range (minus the series' excluded dates).
          const events = [];
          const warnings = [];
          function pushEvent(calName, title, uid, start, end, allDay, location, notes, recurring) {
            if (searchText && title.toLowerCase().indexOf(searchText) === -1) return;
            events.push({
              id: uid,
              calendar: calName,
              title: title,
              startDate: start.toISOString(),
              endDate: end.toISOString(),
              allDay: allDay,
              location: location || null,
              notes: notes || null,
              recurring: recurring
            });
          }
          for (const cal of cals) {
            const calName = cal.name();
            const starts = cal.events.startDate();
            let rules = null;
            try {
              rules = cal.events.recurrence();
            } catch (e) {
              warnings.push("Could not read recurrence rules of calendar '" + calName + "': recurring events may be missing. " + e);
            }

            // hits: { i: event index, start: occurrence start, recurring: bool }
            const hits = [];
            for (let i = 0; i < starts.length; i++) {
              const rule = rules && rules[i] ? String(rules[i]) : "";
              if (rule === "") {
                if (starts[i] >= rangeStart && starts[i] < rangeEnd) hits.push({ i: i, start: starts[i], recurring: false });
                continue;
              }
              if (starts[i] >= rangeEnd) continue;
              const expanded = expandRecurrence(rule, starts[i], rangeStart, rangeEnd, 500);
              if (expanded.unsupported) {
                warnings.push("Unsupported recurrence rule '" + rule + "' (" + expanded.unsupported + "); only the first occurrence of that series is listed.");
                if (starts[i] >= rangeStart) hits.push({ i: i, start: starts[i], recurring: true });
                continue;
              }
              if (expanded.dates.length === 0) continue;
              let excluded = [];
              try {
                excluded = cal.events[i].excludedDates().map(function (d) { return d.getTime(); });
              } catch (e) {
                // no excluded dates readable - keep every occurrence
              }
              for (const d of expanded.dates) {
                const t = d.getTime();
                const isExcluded = excluded.some(function (x) { return Math.abs(x - t) < 60000; });
                if (!isExcluded) hits.push({ i: i, start: d, recurring: true });
              }
            }
            if (hits.length === 0) continue;

            const distinct = {};
            for (const h of hits) distinct[h.i] = true;
            if (Object.keys(distinct).length * 34 < starts.length) {
              for (const h of hits) {
                const ev = cal.events[h.i];
                const duration = ev.endDate().getTime() - starts[h.i].getTime();
                pushEvent(calName, ev.summary() || "", ev.uid(), h.start, new Date(h.start.getTime() + duration), ev.alldayEvent(), ev.location(), ev.description(), h.recurring);
              }
            } else {
              const titles = cal.events.summary();
              const uids = cal.events.uid();
              const ends = cal.events.endDate();
              const allDays = cal.events.alldayEvent();
              const locations = cal.events.location();
              const descriptions = cal.events.description();
              for (const h of hits) {
                const duration = ends[h.i].getTime() - starts[h.i].getTime();
                pushEvent(calName, titles[h.i] || "", uids[h.i], h.start, new Date(h.start.getTime() + duration), allDays[h.i], locations[h.i], descriptions[h.i], h.recurring);
              }
            }
          }
          events.sort(function (a, b) { return a.startDate < b.startDate ? -1 : 1; });
          return JSON.stringify({ events: events.slice(0, limit), warnings: warnings });
        })()
      `;
      const { events, warnings } = await runJXAJson<{ events: CalendarEvent[]; warnings: string[] }>(script, 120_000);
      const warningText = warnings.length > 0 ? `\n\nWarnings:\n- ${warnings.join("\n- ")}` : "";
      if (events.length === 0) {
        return textContent(`No events found between ${params.start_date} and ${params.end_date}.${warningText}`);
      }
      return {
        ...textContent(truncate(JSON.stringify(events, null, 2), CHARACTER_LIMIT) + warningText),
        structuredContent: { events, warnings }
      };
    }
  );

  const CreateEventInput = z
    .object({
      calendar_name: z.string().describe("Exact name of the calendar to add the event to (see calendar_list_calendars)."),
      title: z.string().min(1).describe("Event title/summary."),
      start_date: z.string().describe("ISO 8601 start date-time, e.g. '2026-09-26T09:00:00'."),
      end_date: z.string().describe("ISO 8601 end date-time, e.g. '2026-09-26T10:00:00'."),
      all_day: z.boolean().default(false).describe("Whether this is an all-day event."),
      location: z.string().optional().describe("Event location text."),
      notes: z.string().optional().describe("Free-text notes/description for the event.")
    })
    .strict();

  server.registerTool(
    "calendar_create_event",
    {
      title: "Create Calendar Event",
      description: `Creates a new event in the given calendar.

Args:
  - calendar_name (string): exact calendar name, from calendar_list_calendars
  - title (string): event title
  - start_date / end_date (string): ISO 8601 date-times
  - all_day (boolean, optional): default false
  - location (string, optional)
  - notes (string, optional)

Returns: JSON { id, calendar, title, startDate, endDate, allDay, location, notes } for the created event.

Error Handling:
  - Returns "Error: Calendar '<name>' not found" if calendar_name doesn't match any calendar exactly (case-sensitive).`,
      inputSchema: CreateEventInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (params: z.infer<typeof CreateEventInput>) => {
      const script = `
        (function () {
          const app = Application('Calendar');
          const params = ${toJXALiteral(params)};
          const cals = app.calendars.whose({ name: params.calendar_name })();
          if (cals.length === 0) {
            return JSON.stringify({ error: "Calendar '" + params.calendar_name + "' not found" });
          }
          const cal = cals[0];
          const newEvent = app.Event({
            summary: params.title,
            startDate: new Date(params.start_date),
            endDate: new Date(params.end_date),
            alldayEvent: !!params.all_day
          });
          cal.events.push(newEvent);
          if (params.location) newEvent.location = params.location;
          if (params.notes) newEvent.description = params.notes;
          return JSON.stringify({
            id: newEvent.uid(),
            calendar: cal.name(),
            title: newEvent.summary(),
            startDate: newEvent.startDate().toISOString(),
            endDate: newEvent.endDate().toISOString(),
            allDay: newEvent.alldayEvent(),
            location: newEvent.location() || null,
            notes: newEvent.description() || null
          });
        })()
      `;
      const result = await runJXAJson<CalendarEvent & { error?: string }>(script);
      if (result.error) return textContent(`Error: ${result.error}`);
      return { ...textContent(JSON.stringify(result, null, 2)), structuredContent: { ...result } };
    }
  );

  const UpdateEventInput = z
    .object({
      calendar_name: z.string().describe("Calendar the event currently lives in."),
      event_id: z.string().describe("Event uid, from calendar_list_events or calendar_create_event."),
      title: z.string().optional(),
      start_date: z.string().optional().describe("ISO 8601, only if changing the start time."),
      end_date: z.string().optional().describe("ISO 8601, only if changing the end time."),
      location: z.string().optional(),
      notes: z.string().optional()
    })
    .strict();

  server.registerTool(
    "calendar_update_event",
    {
      title: "Update Calendar Event",
      description: `Updates one or more fields of an existing event. Only fields you provide are changed.

Args:
  - calendar_name (string): calendar the event is in
  - event_id (string): the event's uid
  - title, start_date, end_date, location, notes (all optional): new values

Returns: JSON of the updated event, or "Error: Event not found" if event_id doesn't match anything in that calendar.`,
      inputSchema: UpdateEventInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: z.infer<typeof UpdateEventInput>) => {
      const script = `
        (function () {
          const app = Application('Calendar');
          const params = ${toJXALiteral(params)};
          const cals = app.calendars.whose({ name: params.calendar_name })();
          if (cals.length === 0) return JSON.stringify({ error: "Calendar '" + params.calendar_name + "' not found" });
          const events = cals[0].events.whose({ uid: params.event_id })();
          if (events.length === 0) return JSON.stringify({ error: "Event not found" });
          const e = events[0];
          if (params.title !== undefined) e.summary = params.title;
          if (params.start_date !== undefined) e.startDate = new Date(params.start_date);
          if (params.end_date !== undefined) e.endDate = new Date(params.end_date);
          if (params.location !== undefined) e.location = params.location;
          if (params.notes !== undefined) e.description = params.notes;
          return JSON.stringify({
            id: e.uid(),
            calendar: cals[0].name(),
            title: e.summary(),
            startDate: e.startDate().toISOString(),
            endDate: e.endDate().toISOString(),
            allDay: e.alldayEvent(),
            location: e.location() || null,
            notes: e.description() || null
          });
        })()
      `;
      const result = await runJXAJson<CalendarEvent & { error?: string }>(script);
      if (result.error) return textContent(`Error: ${result.error}`);
      return { ...textContent(JSON.stringify(result, null, 2)), structuredContent: { ...result } };
    }
  );

  const DeleteEventInput = z
    .object({
      calendar_name: z.string(),
      event_id: z.string()
    })
    .strict();

  server.registerTool(
    "calendar_delete_event",
    {
      title: "Delete Calendar Event",
      description: `Permanently deletes one event. This cannot be undone. For a recurring event this deletes the ENTIRE series
(all occurrences share one id), not just a single occurrence.

Args:
  - calendar_name (string): calendar the event is in
  - event_id (string): the event's uid, from calendar_list_events

Returns: "Deleted event '<title>'" on success, or "Error: Event not found".`,
      inputSchema: DeleteEventInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async (params: z.infer<typeof DeleteEventInput>) => {
      const script = `
        (function () {
          const app = Application('Calendar');
          const params = ${toJXALiteral(params)};
          const cals = app.calendars.whose({ name: params.calendar_name })();
          if (cals.length === 0) return JSON.stringify({ error: "Calendar '" + params.calendar_name + "' not found" });
          const events = cals[0].events.whose({ uid: params.event_id })();
          if (events.length === 0) return JSON.stringify({ error: "Event not found" });
          const title = events[0].summary();
          app.delete(events[0]);
          return JSON.stringify({ title: title });
        })()
      `;
      const result = await runJXAJson<{ title?: string; error?: string }>(script);
      if (result.error) return textContent(`Error: ${result.error}`);
      return textContent(`Deleted event '${result.title}'`);
    }
  );
}
