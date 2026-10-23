import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { runJXAJson, toJXALiteral } from "./services/jxa.js";

// Explicit lists: a newly added tool is never exposed remotely by accident.
export const READ_TOOLS = new Set([
  "calendar_list_calendars", "calendar_list_events", "notes_list_folders",
  "notes_list_notes", "notes_get_note", "reminders_list_lists",
  "reminders_list_reminders", "mail_list_accounts", "mail_list_mailboxes",
  "mail_list_messages", "mail_get_message"
]);
export const WRITE_TOOLS = new Set([
  "calendar_create_event", "calendar_update_event", "calendar_delete_event",
  "notes_create_note", "notes_update_note", "notes_delete_note",
  "reminders_create_reminder", "reminders_update_reminder", "reminders_complete_reminder",
  "reminders_delete_reminder", "mail_mark_read", "mail_flag_message", "mail_delete_message",
  "mail_create_draft", "mail_send_message"
]);
export type ConfirmWrite = (name: string, params: unknown) => Promise<boolean>;

export async function confirmOnMac(name: string, params: unknown): Promise<boolean> {
  const details = JSON.stringify(params, null, 2);
  // Refuse rather than truncate: every argument must be visible to the approver.
  if (details.length > 4000) return false;
  try {
    return await runJXAJson<boolean>(`(function () {
      const app = Application.currentApplication();
      app.includeStandardAdditions = true;
      const result = app.displayDialog(${toJXALiteral(`Apple MCP HTTP write request\n\n${name}\n\n${details}\n\nApprove exactly this action? Deletions and sends may be irreversible.`)}, {
        withTitle: 'Apple MCP approval', buttons: ['Cancel', 'Approve'],
        defaultButton: 'Cancel', cancelButton: 'Cancel', givingUpAfter: 60
      });
      return JSON.stringify(!result.gaveUp && result.buttonReturned === 'Approve');
    })()`, 65_000);
  } catch {
    return false;
  }
}

export function parseWriteTools(value = ""): Set<string> {
  const names = new Set(value.split(",").map(x => x.trim()).filter(Boolean));
  for (const name of names) {
    if (!WRITE_TOOLS.has(name)) throw new Error(`Unknown HTTP write tool: ${name}`);
  }
  return names;
}

export function remoteRegistrar(server: McpServer, writes: Set<string>, confirm: ConfirmWrite): Pick<McpServer, "registerTool"> {
  const register = server.registerTool.bind(server);
  let busy = false;
  // Keep the SDK's generic signature for the tool modules. This adapter receives
  // the SDK-validated arguments and delegates to their original typed callbacks.
  const registerTool = ((name: string, config: Parameters<McpServer["registerTool"]>[1], callback: (...args: any[]) => any) => {
    const writable = WRITE_TOOLS.has(name) && writes.has(name);
    const tool = register(name, config, async (...args: any[]): Promise<CallToolResult> => {
      if (busy) return { isError: true, content: [{ type: "text", text: "Server busy; another Apple action is in progress." }] };
      busy = true;
      try {
        if (writable && (args[1]?.signal?.aborted || !await confirm(name, args[0]) || args[1]?.signal?.aborted)) {
          return { isError: true, content: [{ type: "text", text: "Write denied: local approval was cancelled, unavailable, timed out, or the arguments were too large." }] };
        }
        return await callback(...args);
      } finally {
        busy = false;
      }
    });
    if (!READ_TOOLS.has(name) && !writable) tool.disable();
    return tool;
  }) as McpServer["registerTool"];
  return { registerTool };
}
