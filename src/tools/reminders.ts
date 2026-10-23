import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runJXAJson, toJXALiteral } from "../services/jxa.js";
import { ReminderListInfo, ReminderSummary, truncate } from "../types.js";
import { CHARACTER_LIMIT, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from "../constants.js";

function textContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function registerRemindersTools(server: Pick<McpServer, "registerTool">): void {
  server.registerTool(
    "reminders_list_lists",
    {
      title: "List Reminder Lists",
      description: `Lists every list in the macOS Reminders app (e.g. "Reminders", "Groceries", "Work").

Use this to find the exact list name to pass into reminders_list_reminders or reminders_create_reminder.

Returns: JSON array of { name: string }.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      const script = `
        (function () {
          const app = Application('Reminders');
          const lists = app.lists().map(function (l) { return { name: l.name() }; });
          return JSON.stringify(lists);
        })()
      `;
      const lists = await runJXAJson<ReminderListInfo[]>(script);
      return {
        ...textContent(truncate(JSON.stringify(lists, null, 2), CHARACTER_LIMIT)),
        structuredContent: { lists }
      };
    }
  );

  const ListRemindersInput = z
    .object({
      list_name: z.string().optional().describe("Only include reminders from this list. Omit to search every list."),
      include_completed: z.boolean().default(false).describe("Whether to include already-completed reminders."),
      search_text: z.string().optional().describe("Only include reminders whose name contains this text (case-insensitive)."),
      due_before: z.string().optional().describe("ISO 8601 - only include reminders due before this date-time."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIST_LIMIT)
        .default(DEFAULT_LIST_LIMIT)
        .describe(`Maximum reminders to return (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}).`)
    })
    .strict();

  server.registerTool(
    "reminders_list_reminders",
    {
      title: "List Reminders",
      description: `Lists reminders, optionally filtered by list, completion state, due date and/or text search.

Args:
  - list_name (string, optional): restrict to one list
  - include_completed (boolean, optional): default false (only open reminders)
  - search_text (string, optional): case-insensitive substring match on the reminder's name
  - due_before (string, optional): ISO 8601, e.g. use "today plus 1 day" as an end-of-today boundary for "due today"
  - limit (number, optional): max results, default ${DEFAULT_LIST_LIMIT}

Returns: JSON array of { id, list, name, body, dueDate, completed, priority }. "priority" follows Reminders.app's
own scale: 0 = none, 1 = high, 5 = medium, 9 = low. Pass "id" to reminders_update_reminder / _complete_reminder / _delete_reminder.

Error Handling:
  - Returns an empty array (not an error) if nothing matches.`,
      inputSchema: ListRemindersInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: z.infer<typeof ListRemindersInput>) => {
      const script = `
        (function () {
          const app = Application('Reminders');
          const params = ${toJXALiteral(params)};
          const searchText = params.search_text ? params.search_text.toLowerCase() : null;
          const dueBefore = params.due_before ? new Date(params.due_before) : null;

          let lists;
          if (params.list_name) {
            lists = app.lists.whose({ name: params.list_name })();
            if (lists.length === 0) return JSON.stringify({ error: "List '" + params.list_name + "' not found" });
          } else {
            lists = app.lists();
          }

          const result = [];
          // Performance: bulk-read each property on the whole collection (one
          // Apple Event per property) instead of one per reminder.
          for (const l of lists) {
            if (result.length >= params.limit) break;
            const spec = params.include_completed ? l.reminders : l.reminders.whose({ completed: false });
            const names = spec.name();
            if (names.length === 0) continue;
            const ids = spec.id();
            const dues = spec.dueDate();
            const bodies = spec.body();
            const completes = spec.completed();
            const priorities = spec.priority();
            const listName = l.name();
            for (let i = 0; i < names.length; i++) {
              const name = names[i] || "";
              if (searchText && name.toLowerCase().indexOf(searchText) === -1) continue;
              const due = dues[i];
              if (dueBefore && (!due || due >= dueBefore)) continue;
              result.push({
                id: ids[i],
                list: listName,
                name: name,
                body: bodies[i] || null,
                dueDate: due ? due.toISOString() : null,
                completed: completes[i],
                priority: priorities[i]
              });
            }
          }
          return JSON.stringify(result.slice(0, params.limit));
        })()
      `;
      const result = await runJXAJson<ReminderSummary[] | { error: string }>(script, 30_000);
      if (!Array.isArray(result)) return textContent(`Error: ${result.error}`);
      if (result.length === 0) return textContent("No reminders found matching the given filters.");
      return {
        ...textContent(truncate(JSON.stringify(result, null, 2), CHARACTER_LIMIT)),
        structuredContent: { reminders: result }
      };
    }
  );

  const CreateReminderInput = z
    .object({
      list_name: z.string().describe("Exact list name (see reminders_list_lists)."),
      name: z.string().min(1).describe("Reminder title."),
      body: z.string().optional().describe("Notes text for the reminder."),
      due_date: z.string().optional().describe("ISO 8601 date-time the reminder is due."),
      priority: z
        .number()
        .int()
        .min(0)
        .max(9)
        .default(0)
        .describe("0 = none, 1 = high, 5 = medium, 9 = low (Reminders.app's own scale).")
    })
    .strict();

  server.registerTool(
    "reminders_create_reminder",
    {
      title: "Create Reminder",
      description: `Creates a new reminder in the given list.

Args:
  - list_name (string): exact list name, from reminders_list_lists
  - name (string): reminder title
  - body (string, optional): notes text
  - due_date (string, optional): ISO 8601
  - priority (number, optional): 0-9, default 0 (none)

Returns: JSON of the created reminder.

Error Handling:
  - Returns "Error: List '<name>' not found" if list_name doesn't match exactly.`,
      inputSchema: CreateReminderInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (params: z.infer<typeof CreateReminderInput>) => {
      const script = `
        (function () {
          const app = Application('Reminders');
          const params = ${toJXALiteral(params)};
          const lists = app.lists.whose({ name: params.list_name })();
          if (lists.length === 0) return JSON.stringify({ error: "List '" + params.list_name + "' not found" });
          const list = lists[0];
          const props = { name: params.name, priority: params.priority };
          if (params.body) props.body = params.body;
          if (params.due_date) props.dueDate = new Date(params.due_date);
          const newReminder = app.Reminder(props);
          list.reminders.push(newReminder);
          return JSON.stringify({
            id: newReminder.id(),
            list: list.name(),
            name: newReminder.name(),
            body: newReminder.body() || null,
            dueDate: newReminder.dueDate() ? newReminder.dueDate().toISOString() : null,
            completed: newReminder.completed(),
            priority: newReminder.priority()
          });
        })()
      `;
      const result = await runJXAJson<ReminderSummary & { error?: string }>(script);
      if (result.error) return textContent(`Error: ${result.error}`);
      return { ...textContent(JSON.stringify(result, null, 2)), structuredContent: { ...result } };
    }
  );

  const UpdateReminderInput = z
    .object({
      list_name: z.string().describe("List the reminder currently lives in."),
      reminder_id: z.string().describe("Reminder id, from reminders_list_reminders."),
      name: z.string().optional(),
      body: z.string().optional(),
      due_date: z.string().optional().describe("ISO 8601. Pass an empty string to clear the due date."),
      priority: z.number().int().min(0).max(9).optional(),
      completed: z.boolean().optional()
    })
    .strict();

  server.registerTool(
    "reminders_update_reminder",
    {
      title: "Update Reminder",
      description: `Updates one or more fields of an existing reminder. Only fields you provide are changed.

Args:
  - list_name (string): list the reminder is in
  - reminder_id (string): the reminder's id
  - name, body, due_date, priority, completed (all optional): new values. due_date "" clears the due date.

Returns: JSON of the updated reminder, or "Error: Reminder not found".`,
      inputSchema: UpdateReminderInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: z.infer<typeof UpdateReminderInput>) => {
      const script = `
        (function () {
          const app = Application('Reminders');
          const params = ${toJXALiteral(params)};
          const lists = app.lists.whose({ name: params.list_name })();
          if (lists.length === 0) return JSON.stringify({ error: "List '" + params.list_name + "' not found" });
          const matches = lists[0].reminders.whose({ id: params.reminder_id })();
          if (matches.length === 0) return JSON.stringify({ error: "Reminder not found" });
          const r = matches[0];
          if (params.name !== undefined) r.name = params.name;
          if (params.body !== undefined) r.body = params.body;
          if (params.due_date !== undefined) r.dueDate = params.due_date === "" ? null : new Date(params.due_date);
          if (params.priority !== undefined) r.priority = params.priority;
          if (params.completed !== undefined) r.completed = params.completed;
          return JSON.stringify({
            id: r.id(),
            list: lists[0].name(),
            name: r.name(),
            body: r.body() || null,
            dueDate: r.dueDate() ? r.dueDate().toISOString() : null,
            completed: r.completed(),
            priority: r.priority()
          });
        })()
      `;
      const result = await runJXAJson<ReminderSummary & { error?: string }>(script);
      if (result.error) return textContent(`Error: ${result.error}`);
      return { ...textContent(JSON.stringify(result, null, 2)), structuredContent: { ...result } };
    }
  );

  const CompleteReminderInput = z
    .object({
      list_name: z.string(),
      reminder_id: z.string(),
      completed: z.boolean().default(true).describe("true to mark complete (default), false to mark incomplete again.")
    })
    .strict();

  server.registerTool(
    "reminders_complete_reminder",
    {
      title: "Complete Reminder",
      description: `Marks a reminder as completed (or, with completed=false, un-completes it again).

Args:
  - list_name (string): list the reminder is in
  - reminder_id (string): from reminders_list_reminders
  - completed (boolean, optional): default true

Returns: "Marked '<name>' as completed" / "as not completed", or "Error: Reminder not found".`,
      inputSchema: CompleteReminderInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: z.infer<typeof CompleteReminderInput>) => {
      const script = `
        (function () {
          const app = Application('Reminders');
          const params = ${toJXALiteral(params)};
          const lists = app.lists.whose({ name: params.list_name })();
          if (lists.length === 0) return JSON.stringify({ error: "List '" + params.list_name + "' not found" });
          const matches = lists[0].reminders.whose({ id: params.reminder_id })();
          if (matches.length === 0) return JSON.stringify({ error: "Reminder not found" });
          matches[0].completed = params.completed;
          return JSON.stringify({ name: matches[0].name() });
        })()
      `;
      const result = await runJXAJson<{ name?: string; error?: string }>(script);
      if (result.error) return textContent(`Error: ${result.error}`);
      return textContent(`Marked '${result.name}' as ${params.completed ? "completed" : "not completed"}`);
    }
  );

  const DeleteReminderInput = z.object({ list_name: z.string(), reminder_id: z.string() }).strict();

  server.registerTool(
    "reminders_delete_reminder",
    {
      title: "Delete Reminder",
      description: `Permanently deletes one reminder. This cannot be undone.

Args:
  - list_name (string): list the reminder is in
  - reminder_id (string): from reminders_list_reminders

Returns: "Deleted reminder '<name>'" on success, or "Error: Reminder not found".`,
      inputSchema: DeleteReminderInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async (params: z.infer<typeof DeleteReminderInput>) => {
      const script = `
        (function () {
          const app = Application('Reminders');
          const params = ${toJXALiteral(params)};
          const lists = app.lists.whose({ name: params.list_name })();
          if (lists.length === 0) return JSON.stringify({ error: "List '" + params.list_name + "' not found" });
          const matches = lists[0].reminders.whose({ id: params.reminder_id })();
          if (matches.length === 0) return JSON.stringify({ error: "Reminder not found" });
          const name = matches[0].name();
          app.delete(matches[0]);
          return JSON.stringify({ name: name });
        })()
      `;
      const result = await runJXAJson<{ name?: string; error?: string }>(script);
      if (result.error) return textContent(`Error: ${result.error}`);
      return textContent(`Deleted reminder '${result.name}'`);
    }
  );
}
