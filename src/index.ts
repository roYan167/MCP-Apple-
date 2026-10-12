#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCalendarTools } from "./tools/calendar.js";
import { registerNotesTools } from "./tools/notes.js";
import { registerRemindersTools } from "./tools/reminders.js";
import { registerMailTools } from "./tools/mail.js";

async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    console.error(
      "apple-productivity-mcp-server only works on macOS: it automates the Calendar, Notes, Reminders and Mail " +
        "apps via AppleScript/JXA, which only exist on macOS."
    );
    process.exit(1);
  }

  const server = new McpServer({
    name: "apple-productivity-mcp-server",
    version: "1.1.0"
  });

  registerCalendarTools(server);
  registerNotesTools(server);
  registerRemindersTools(server);
  registerMailTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("apple-productivity-mcp-server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
