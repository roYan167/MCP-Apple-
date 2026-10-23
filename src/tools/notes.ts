import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runJXAJson, toJXALiteral } from "../services/jxa.js";
import { NoteDetail, NoteFolderInfo, NoteSummary, truncate } from "../types.js";
import { CHARACTER_LIMIT, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from "../constants.js";

function textContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// Notes.app derives a note's displayed title from the first line of its
// body - there is no separate, independently settable "title" field. Every
// tool below therefore treats the body's first line as the title, and says
// so in its description, instead of pretending a separate title exists.

export function registerNotesTools(server: Pick<McpServer, "registerTool">): void {
  server.registerTool(
    "notes_list_folders",
    {
      title: "List Note Folders",
      description: `Lists every folder in the macOS Notes app (e.g. "Notes", "Work", a folder inside an iCloud account).

Use this to find the exact folder name to pass into notes_list_notes or notes_create_note.

Returns: JSON array of { name: string }.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      const script = `
        (function () {
          const app = Application('Notes');
          const folders = app.folders().map(function (f) { return { name: f.name() }; });
          return JSON.stringify(folders);
        })()
      `;
      const folders = await runJXAJson<NoteFolderInfo[]>(script);
      return {
        ...textContent(truncate(JSON.stringify(folders, null, 2), CHARACTER_LIMIT)),
        structuredContent: { folders }
      };
    }
  );

  const ListNotesInput = z
    .object({
      folder_name: z.string().optional().describe("Only include notes in this folder. Omit to search every folder."),
      search_text: z
        .string()
        .optional()
        .describe("Only include notes whose title or body contains this text (case-insensitive)."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIST_LIMIT)
        .default(DEFAULT_LIST_LIMIT)
        .describe(`Maximum notes to return, most recently modified first (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}).`)
    })
    .strict();

  server.registerTool(
    "notes_list_notes",
    {
      title: "List Notes",
      description: `Lists notes, most recently modified first, optionally filtered by folder and/or a text search over title+body.

Args:
  - folder_name (string, optional): restrict to one folder
  - search_text (string, optional): case-insensitive substring match against the note's plain text (title + body)
  - limit (number, optional): max results, default ${DEFAULT_LIST_LIMIT}

Returns: JSON array of { id, folder, name, modificationDate, preview }. "preview" is a short plain-text excerpt.
Pass "id" to notes_get_note, notes_update_note or notes_delete_note.

Error Handling:
  - Returns an empty array (not an error) if nothing matches.
  - Large note libraries can take a few seconds to scan - narrow with folder_name or search_text when possible.`,
      inputSchema: ListNotesInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: z.infer<typeof ListNotesInput>) => {
      const script = `
        (function () {
          const app = Application('Notes');
          const params = ${toJXALiteral(params)};
          const searchText = params.search_text ? params.search_text.toLowerCase() : null;

          // Performance: every property read on a single note is its own Apple
          // Event round trip, so looping over thousands of notes times out.
          // Reading a property on the whole collection (app.notes.x()) is ONE
          // round trip that returns an array in the same order as the
          // collection. We therefore rank/filter on those bulk arrays first and
          // only touch individual notes for the few that make it into the result.
          let coll;
          let folderNameForEach = null;
          if (params.folder_name) {
            const folders = app.folders.whose({ name: params.folder_name })();
            if (folders.length === 0) return JSON.stringify({ error: "Folder '" + params.folder_name + "' not found" });
            coll = folders[0].notes;
            folderNameForEach = params.folder_name;
          } else {
            coll = app.notes;
          }

          const dates = coll.modificationDate();
          let idx = [];
          for (let i = 0; i < dates.length; i++) idx.push(i);

          if (searchText) {
            // Two more bulk reads; still constant in the number of Apple Events.
            const plains = coll.plaintext();
            const names = coll.name();
            idx = idx.filter(function (i) {
              return plains[i].toLowerCase().indexOf(searchText) !== -1 || names[i].toLowerCase().indexOf(searchText) !== -1;
            });
          }

          idx.sort(function (a, b) { return dates[b] - dates[a]; });
          idx = idx.slice(0, params.limit);

          const result = idx.map(function (i) {
            const n = coll[i];
            const plain = n.plaintext();
            let folderName = folderNameForEach;
            if (!folderName) {
              try { folderName = n.container().name(); } catch (e) { folderName = null; }
            }
            const firstLineEnd = plain.indexOf("\\n");
            const bodyAfterTitle = firstLineEnd === -1 ? "" : plain.slice(firstLineEnd + 1).trim();
            return {
              id: n.id(),
              folder: folderName,
              name: n.name(),
              modificationDate: dates[i].toISOString(),
              preview: bodyAfterTitle.slice(0, 200)
            };
          });
          return JSON.stringify(result);
        })()
      `;
      const result = await runJXAJson<NoteSummary[] | { error: string }>(script, 30_000);
      if (!Array.isArray(result)) return textContent(`Error: ${result.error}`);
      if (result.length === 0) return textContent("No notes found matching the given filters.");
      return {
        ...textContent(truncate(JSON.stringify(result, null, 2), CHARACTER_LIMIT)),
        structuredContent: { notes: result }
      };
    }
  );

  const GetNoteInput = z.object({ note_id: z.string().describe("Note id, from notes_list_notes.") }).strict();

  server.registerTool(
    "notes_get_note",
    {
      title: "Get Note",
      description: `Fetches the full content of one note by id.

Args:
  - note_id (string): from notes_list_notes

Returns: JSON { id, folder, name, modificationDate, body } where "body" is the note's full plain text (the HTML
formatting Notes.app stores internally is flattened to plain text for readability).

Error Handling:
  - Returns "Error: Note not found" if note_id doesn't match any note.`,
      inputSchema: GetNoteInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: z.infer<typeof GetNoteInput>) => {
      const script = `
        (function () {
          const app = Application('Notes');
          const params = ${toJXALiteral(params)};
          const matches = app.notes.whose({ id: params.note_id })();
          if (matches.length === 0) return JSON.stringify({ error: "Note not found" });
          const n = matches[0];
          let folderName = null;
          try { folderName = n.container().name(); } catch (e) {}
          return JSON.stringify({
            id: n.id(),
            folder: folderName,
            name: n.name(),
            modificationDate: n.modificationDate().toISOString(),
            body: n.plaintext()
          });
        })()
      `;
      const result = await runJXAJson<(NoteDetail & { body: string }) | { error: string }>(script);
      if ("error" in result) return textContent(`Error: ${result.error}`);
      return {
        ...textContent(truncate(JSON.stringify(result, null, 2), CHARACTER_LIMIT)),
        structuredContent: { ...result }
      };
    }
  );

  const CreateNoteInput = z
    .object({
      folder_name: z.string().describe("Exact folder name to create the note in (see notes_list_folders)."),
      body: z
        .string()
        .min(1)
        .describe(
          "Full note text. The FIRST LINE becomes the note's title in Notes.app - put the title on its own first line, then a blank line, then the rest."
        )
    })
    .strict();

  server.registerTool(
    "notes_create_note",
    {
      title: "Create Note",
      description: `Creates a new note in the given folder.

Args:
  - folder_name (string): exact folder name, from notes_list_folders
  - body (string): full note text; its first line becomes the note's title (this is how Notes.app itself works,
    there's no separate title field)

Returns: JSON { id, folder, name, modificationDate, body } for the created note.

Error Handling:
  - Returns "Error: Folder '<name>' not found" if folder_name doesn't match exactly.`,
      inputSchema: CreateNoteInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (params: z.infer<typeof CreateNoteInput>) => {
      const script = `
        (function () {
          const app = Application('Notes');
          const params = ${toJXALiteral(params)};
          const folders = app.folders.whose({ name: params.folder_name })();
          if (folders.length === 0) return JSON.stringify({ error: "Folder '" + params.folder_name + "' not found" });
          const folder = folders[0];
          const lines = params.body.split("\\n");
          const html = lines.map(function (line) { return "<div>" + line.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</div>"; }).join("");
          const newNote = app.Note({ body: html });
          folder.notes.push(newNote);
          return JSON.stringify({
            id: newNote.id(),
            folder: folder.name(),
            name: newNote.name(),
            modificationDate: newNote.modificationDate().toISOString(),
            body: newNote.plaintext()
          });
        })()
      `;
      const result = await runJXAJson<(NoteDetail & { body: string }) | { error: string }>(script);
      if ("error" in result) return textContent(`Error: ${result.error}`);
      return { ...textContent(JSON.stringify(result, null, 2)), structuredContent: { ...result } };
    }
  );

  const UpdateNoteInput = z
    .object({
      note_id: z.string().describe("Note id, from notes_list_notes."),
      body: z
        .string()
        .min(1)
        .describe("Full replacement text for the note. Its first line becomes the note's (new) title.")
    })
    .strict();

  server.registerTool(
    "notes_update_note",
    {
      title: "Update Note",
      description: `Replaces the entire content of an existing note. This is a full replace, not a partial edit - to
change one paragraph, fetch the note with notes_get_note first, edit the text, then send the complete new body here.

Args:
  - note_id (string): from notes_list_notes
  - body (string): full replacement text; first line becomes the title

Returns: JSON of the updated note, or "Error: Note not found".`,
      inputSchema: UpdateNoteInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: z.infer<typeof UpdateNoteInput>) => {
      const script = `
        (function () {
          const app = Application('Notes');
          const params = ${toJXALiteral(params)};
          const matches = app.notes.whose({ id: params.note_id })();
          if (matches.length === 0) return JSON.stringify({ error: "Note not found" });
          const n = matches[0];
          const lines = params.body.split("\\n");
          const html = lines.map(function (line) { return "<div>" + line.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</div>"; }).join("");
          n.body = html;
          let folderName = null;
          try { folderName = n.container().name(); } catch (e) {}
          return JSON.stringify({
            id: n.id(),
            folder: folderName,
            name: n.name(),
            modificationDate: n.modificationDate().toISOString(),
            body: n.plaintext()
          });
        })()
      `;
      const result = await runJXAJson<(NoteDetail & { body: string }) | { error: string }>(script);
      if ("error" in result) return textContent(`Error: ${result.error}`);
      return { ...textContent(JSON.stringify(result, null, 2)), structuredContent: { ...result } };
    }
  );

  const DeleteNoteInput = z.object({ note_id: z.string() }).strict();

  server.registerTool(
    "notes_delete_note",
    {
      title: "Delete Note",
      description: `Permanently deletes one note. This cannot be undone (it does not go to a recoverable trash from
this tool's perspective).

Args:
  - note_id (string): from notes_list_notes

Returns: "Deleted note '<name>'" on success, or "Error: Note not found".`,
      inputSchema: DeleteNoteInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async (params: z.infer<typeof DeleteNoteInput>) => {
      const script = `
        (function () {
          const app = Application('Notes');
          const params = ${toJXALiteral(params)};
          const matches = app.notes.whose({ id: params.note_id })();
          if (matches.length === 0) return JSON.stringify({ error: "Note not found" });
          const name = matches[0].name();
          app.delete(matches[0]);
          return JSON.stringify({ name: name });
        })()
      `;
      const result = await runJXAJson<{ name?: string; error?: string }>(script);
      if (result.error) return textContent(`Error: ${result.error}`);
      return textContent(`Deleted note '${result.name}'`);
    }
  );
}
