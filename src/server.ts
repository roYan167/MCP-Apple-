import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCalendarTools } from "./tools/calendar.js";
import { registerNotesTools } from "./tools/notes.js";
import { registerRemindersTools } from "./tools/reminders.js";
import { registerMailTools } from "./tools/mail.js";
import { ConfirmWrite, confirmOnMac, remoteRegistrar } from "./policy.js";

export function createAppleServer(remote?: { writes: Set<string>; confirm?: ConfirmWrite }): McpServer {
  const server = new McpServer({ name: "apple-productivity-mcp-server", version: "1.1.0" });
  const registrar = remote ? remoteRegistrar(server, remote.writes, remote.confirm ?? confirmOnMac) : server;
  registerCalendarTools(registrar);
  registerNotesTools(registrar);
  registerRemindersTools(registrar);
  registerMailTools(registrar);
  return server;
}
