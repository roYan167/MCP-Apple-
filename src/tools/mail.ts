import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runJXAJson, toJXALiteral } from "../services/jxa.js";
import { MailAccountInfo, MailboxInfo, MailMessageDetail, MailMessageSummary, truncate } from "../types.js";
import { CHARACTER_LIMIT, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from "../constants.js";

function textContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// Mail.app's JXA scripting dictionary is notoriously slower and flakier than
// Calendar/Notes/Reminders, especially `whose()` filters on the `messages`
// collection (they are known to hang or silently ignore some criteria on
// certain macOS versions). To keep things reliable, the list/search tools
// below fetch messages by numeric index in a bounded range and filter in
// plain JS, rather than relying on Mail's own `whose()` predicate on
// messages. This trades a bit of raw speed for predictable behavior.

export function registerMailTools(server: Pick<McpServer, "registerTool">): void {
  // ---------------------------------------------------------------------
  // mail_list_accounts
  // ---------------------------------------------------------------------
  server.registerTool(
    "mail_list_accounts",
    {
      title: "List Mail Accounts",
      description: `Lists every account configured in the macOS Mail app (e.g. an iCloud, Gmail or Exchange account).

Use this first if you need to know which accounts exist before listing mailboxes.

Returns: JSON array of { name: string, email: string | null }.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      const script = `
        (function () {
          const app = Application('Mail');
          const accounts = app.accounts().map(function (a) {
            let email = null;
            try { const addrs = a.emailAddresses(); email = addrs && addrs.length ? addrs[0] : null; } catch (e) {}
            return { name: a.name(), email: email };
          });
          return JSON.stringify(accounts);
        })()
      `;
      const accounts = await runJXAJson<MailAccountInfo[]>(script);
      return {
        ...textContent(truncate(JSON.stringify(accounts, null, 2), CHARACTER_LIMIT)),
        structuredContent: { accounts }
      };
    }
  );

  // ---------------------------------------------------------------------
  // mail_list_mailboxes
  // ---------------------------------------------------------------------
  const ListMailboxesInput = z
    .object({
      account_name: z.string().optional().describe("Only list mailboxes for this account. Omit to list every account's mailboxes.")
    })
    .strict();

  server.registerTool(
    "mail_list_mailboxes",
    {
      title: "List Mailboxes",
      description: `Lists mailboxes (e.g. "INBOX", "Sent", "Drafts", custom folders) across one or all accounts.

Use this to find the exact account_name + mailbox_name to pass into mail_list_messages.

Args:
  - account_name (string, optional): restrict to one account, from mail_list_accounts

Returns: JSON array of { name, account, unreadCount }.

Error Handling:
  - Returns "Error: Account '<name>' not found" if account_name doesn't match exactly.`,
      inputSchema: ListMailboxesInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: z.infer<typeof ListMailboxesInput>) => {
      const script = `
        (function () {
          const app = Application('Mail');
          const params = ${toJXALiteral(params)};
          let accounts = app.accounts();
          if (params.account_name) {
            accounts = accounts.filter(function (a) { return a.name() === params.account_name; });
            if (accounts.length === 0) return JSON.stringify({ error: "Account '" + params.account_name + "' not found" });
          }
          const result = [];
          for (const acc of accounts) {
            const boxes = acc.mailboxes();
            for (const mb of boxes) {
              let unread = 0;
              try { unread = mb.unreadCount(); } catch (e) {}
              result.push({ name: mb.name(), account: acc.name(), unreadCount: unread });
            }
          }
          return JSON.stringify(result);
        })()
      `;
      const result = await runJXAJson<MailboxInfo[] | { error: string }>(script, 30_000);
      if (!Array.isArray(result)) return textContent(`Error: ${result.error}`);
      return {
        ...textContent(truncate(JSON.stringify(result, null, 2), CHARACTER_LIMIT)),
        structuredContent: { mailboxes: result }
      };
    }
  );

  // ---------------------------------------------------------------------
  // mail_list_messages
  // ---------------------------------------------------------------------
  const ListMessagesInput = z
    .object({
      account_name: z.string().describe("Exact account name, from mail_list_accounts."),
      mailbox_name: z.string().default("INBOX").describe("Exact mailbox name, from mail_list_mailboxes. Default 'INBOX'."),
      unread_only: z.boolean().default(false).describe("Only include unread messages."),
      search_text: z
        .string()
        .optional()
        .describe("Only include messages whose subject or sender contains this text (case-insensitive). Does NOT search the body (too slow to scan on large mailboxes)."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIST_LIMIT)
        .default(DEFAULT_LIST_LIMIT)
        .describe(`Maximum messages to return, newest first (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}).`),
      scan_limit: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .default(300)
        .describe("How many of the most recent messages in the mailbox to scan when filtering (unread_only/search_text). Increase if you expect matches further back, at the cost of speed.")
    })
    .strict();

  server.registerTool(
    "mail_list_messages",
    {
      title: "List Mail Messages",
      description: `Lists messages in a mailbox, newest first, optionally filtered to unread and/or a subject/sender text search.

Args:
  - account_name (string): exact account name, from mail_list_accounts
  - mailbox_name (string, optional): exact mailbox name, default "INBOX"
  - unread_only (boolean, optional): default false
  - search_text (string, optional): case-insensitive substring match on subject OR sender (not body)
  - limit (number, optional): max results to return, default ${DEFAULT_LIST_LIMIT}
  - scan_limit (number, optional): how many recent messages to scan through when filtering, default 300

Returns: JSON array of { id, mailbox, account, subject, sender, dateSent, read, flagged, preview }.
Pass "id" (plus account_name/mailbox_name) to mail_get_message, mail_mark_read, mail_flag_message, mail_delete_message.

Error Handling:
  - Returns "Error: Account '<name>' not found" or "Error: Mailbox '<name>' not found in account '<name>'" as appropriate.
  - Returns an empty array (not an error) if nothing matches within scan_limit.
  - Mail.app's own scripting interface is slow on very large mailboxes - this tool scans at most scan_limit
    messages (most recent first) rather than the whole mailbox, to stay responsive.`,
      inputSchema: ListMessagesInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: z.infer<typeof ListMessagesInput>) => {
      const script = `
        (function () {
          const app = Application('Mail');
          const params = ${toJXALiteral(params)};
          const accounts = app.accounts.whose({ name: params.account_name })();
          if (accounts.length === 0) return JSON.stringify({ error: "Account '" + params.account_name + "' not found" });
          const boxes = accounts[0].mailboxes.whose({ name: params.mailbox_name })();
          if (boxes.length === 0) return JSON.stringify({ error: "Mailbox '" + params.mailbox_name + "' not found in account '" + params.account_name + "'" });
          const mailbox = boxes[0];
          const total = mailbox.messages.length;
          const scanCount = Math.min(total, params.scan_limit);
          const searchText = params.search_text ? params.search_text.toLowerCase() : null;

          // Performance: each property read on a single message is its own Apple
          // Event round trip. Reading a property on the whole collection is ONE
          // round trip returning an array in message order (~0.3s for 3000+
          // messages). So we read the light metadata in bulk, filter in memory,
          // and only fetch the heavy body (content) for the few final matches.
          const msgs = mailbox.messages;
          const reads = msgs.readStatus();
          const subjects = msgs.subject();
          const senders = msgs.sender();
          const dates = msgs.dateSent();
          const flags = msgs.flaggedStatus();
          const ids = msgs.id();
          const mailboxName = mailbox.name();
          const accountName = accounts[0].name();

          const result = [];
          for (let i = 0; i < scanCount && result.length < params.limit; i++) {
            if (params.unread_only && reads[i]) continue;
            const subject = subjects[i] || "";
            const sender = senders[i] || "";
            if (searchText) {
              const hay = (subject + " " + sender).toLowerCase();
              if (hay.indexOf(searchText) === -1) continue;
            }
            let preview = "";
            try { preview = (msgs[i].content() || "").slice(0, 200); } catch (e) {}
            result.push({
              id: String(ids[i]),
              mailbox: mailboxName,
              account: accountName,
              subject: subject,
              sender: sender,
              dateSent: dates[i] ? dates[i].toISOString() : null,
              read: reads[i],
              flagged: !!flags[i],
              preview: preview
            });
          }
          return JSON.stringify(result);
        })()
      `;
      const result = await runJXAJson<MailMessageSummary[] | { error: string }>(script, 45_000);
      if (!Array.isArray(result)) return textContent(`Error: ${result.error}`);
      if (result.length === 0) return textContent("No messages found matching the given filters within the scanned range.");
      return {
        ...textContent(truncate(JSON.stringify(result, null, 2), CHARACTER_LIMIT)),
        structuredContent: { messages: result }
      };
    }
  );

  // ---------------------------------------------------------------------
  // mail_get_message
  // ---------------------------------------------------------------------
  const GetMessageInput = z
    .object({
      account_name: z.string().describe("Account the message is in."),
      mailbox_name: z.string().default("INBOX").describe("Mailbox the message is in, default 'INBOX'."),
      message_id: z.string().describe("Message id, from mail_list_messages."),
      scan_limit: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .default(1000)
        .describe("How many messages in the mailbox to scan looking for this id, default 1000.")
    })
    .strict();

  server.registerTool(
    "mail_get_message",
    {
      title: "Get Mail Message",
      description: `Fetches the full content of one email by id.

Args:
  - account_name, mailbox_name (string): where the message lives (mailbox_name defaults to "INBOX")
  - message_id (string): from mail_list_messages
  - scan_limit (number, optional): how many messages to search through to find this id, default 1000

Returns: JSON { id, mailbox, account, subject, sender, recipients, dateSent, read, flagged, body }. "body" is
the message's full plain-text content.

Error Handling:
  - Returns "Error: Message not found" if message_id isn't found within scan_limit messages of the mailbox.`,
      inputSchema: GetMessageInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: z.infer<typeof GetMessageInput>) => {
      const script = `
        (function () {
          const app = Application('Mail');
          const params = ${toJXALiteral(params)};
          const accounts = app.accounts.whose({ name: params.account_name })();
          if (accounts.length === 0) return JSON.stringify({ error: "Account '" + params.account_name + "' not found" });
          const boxes = accounts[0].mailboxes.whose({ name: params.mailbox_name })();
          if (boxes.length === 0) return JSON.stringify({ error: "Mailbox '" + params.mailbox_name + "' not found" });
          const mailbox = boxes[0];
          const total = Math.min(mailbox.messages.length, params.scan_limit);
          for (let i = 0; i < total; i++) {
            let m;
            try { m = mailbox.messages[i]; } catch (e) { continue; }
            if (String(m.id()) !== params.message_id) continue;
            let recipients = [];
            try { recipients = m.recipients().map(function (r) { return r.address() || r.name(); }); } catch (e) {}
            return JSON.stringify({
              id: String(m.id()),
              mailbox: mailbox.name(),
              account: accounts[0].name(),
              subject: m.subject() || "",
              sender: m.sender() || "",
              recipients: recipients,
              dateSent: m.dateSent() ? m.dateSent().toISOString() : null,
              read: (function () { try { return m.readStatus(); } catch (e) { return null; } })(),
              flagged: (function () { try { return m.flaggedStatus(); } catch (e) { return false; } })(),
              body: m.content() || ""
            });
          }
          return JSON.stringify({ error: "Message not found" });
        })()
      `;
      const result = await runJXAJson<(MailMessageDetail & { error?: string }) | { error: string }>(script, 30_000);
      if ("error" in result && result.error) return textContent(`Error: ${result.error}`);
      return {
        ...textContent(truncate(JSON.stringify(result, null, 2), CHARACTER_LIMIT)),
        structuredContent: { ...result }
      };
    }
  );

  // ---------------------------------------------------------------------
  // mail_mark_read
  // ---------------------------------------------------------------------
  const MarkReadInput = z
    .object({
      account_name: z.string(),
      mailbox_name: z.string().default("INBOX"),
      message_id: z.string(),
      read: z.boolean().default(true).describe("true to mark read (default), false to mark unread."),
      scan_limit: z.number().int().min(1).max(5000).default(1000)
    })
    .strict();

  server.registerTool(
    "mail_mark_read",
    {
      title: "Mark Mail Message Read/Unread",
      description: `Marks a message as read (or, with read=false, as unread again).

Args:
  - account_name, mailbox_name (string): where the message lives (mailbox_name defaults to "INBOX")
  - message_id (string): from mail_list_messages
  - read (boolean, optional): default true

Returns: "Marked '<subject>' as read" / "as unread", or "Error: Message not found".`,
      inputSchema: MarkReadInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: z.infer<typeof MarkReadInput>) => {
      const script = `
        (function () {
          const app = Application('Mail');
          const params = ${toJXALiteral(params)};
          const accounts = app.accounts.whose({ name: params.account_name })();
          if (accounts.length === 0) return JSON.stringify({ error: "Account '" + params.account_name + "' not found" });
          const boxes = accounts[0].mailboxes.whose({ name: params.mailbox_name })();
          if (boxes.length === 0) return JSON.stringify({ error: "Mailbox '" + params.mailbox_name + "' not found" });
          const mailbox = boxes[0];
          const total = Math.min(mailbox.messages.length, params.scan_limit);
          for (let i = 0; i < total; i++) {
            let m;
            try { m = mailbox.messages[i]; } catch (e) { continue; }
            if (String(m.id()) !== params.message_id) continue;
            m.readStatus = params.read;
            return JSON.stringify({ subject: m.subject() || "" });
          }
          return JSON.stringify({ error: "Message not found" });
        })()
      `;
      const result = await runJXAJson<{ subject?: string; error?: string }>(script, 30_000);
      if (result.error) return textContent(`Error: ${result.error}`);
      return textContent(`Marked '${result.subject}' as ${params.read ? "read" : "unread"}`);
    }
  );

  // ---------------------------------------------------------------------
  // mail_flag_message
  // ---------------------------------------------------------------------
  const FlagMessageInput = z
    .object({
      account_name: z.string(),
      mailbox_name: z.string().default("INBOX"),
      message_id: z.string(),
      flagged: z.boolean().default(true).describe("true to flag (default), false to remove the flag."),
      scan_limit: z.number().int().min(1).max(5000).default(1000)
    })
    .strict();

  server.registerTool(
    "mail_flag_message",
    {
      title: "Flag/Unflag Mail Message",
      description: `Flags a message (or, with flagged=false, removes its flag).

Args:
  - account_name, mailbox_name (string): where the message lives (mailbox_name defaults to "INBOX")
  - message_id (string): from mail_list_messages
  - flagged (boolean, optional): default true

Returns: "Flagged '<subject>'" / "Unflagged '<subject>'", or "Error: Message not found".`,
      inputSchema: FlagMessageInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (params: z.infer<typeof FlagMessageInput>) => {
      const script = `
        (function () {
          const app = Application('Mail');
          const params = ${toJXALiteral(params)};
          const accounts = app.accounts.whose({ name: params.account_name })();
          if (accounts.length === 0) return JSON.stringify({ error: "Account '" + params.account_name + "' not found" });
          const boxes = accounts[0].mailboxes.whose({ name: params.mailbox_name })();
          if (boxes.length === 0) return JSON.stringify({ error: "Mailbox '" + params.mailbox_name + "' not found" });
          const mailbox = boxes[0];
          const total = Math.min(mailbox.messages.length, params.scan_limit);
          for (let i = 0; i < total; i++) {
            let m;
            try { m = mailbox.messages[i]; } catch (e) { continue; }
            if (String(m.id()) !== params.message_id) continue;
            m.flaggedStatus = params.flagged;
            return JSON.stringify({ subject: m.subject() || "" });
          }
          return JSON.stringify({ error: "Message not found" });
        })()
      `;
      const result = await runJXAJson<{ subject?: string; error?: string }>(script, 30_000);
      if (result.error) return textContent(`Error: ${result.error}`);
      return textContent(`${params.flagged ? "Flagged" : "Unflagged"} '${result.subject}'`);
    }
  );

  // ---------------------------------------------------------------------
  // mail_delete_message
  // ---------------------------------------------------------------------
  const DeleteMessageInput = z
    .object({
      account_name: z.string(),
      mailbox_name: z.string().default("INBOX"),
      message_id: z.string(),
      scan_limit: z.number().int().min(1).max(5000).default(1000)
    })
    .strict();

  server.registerTool(
    "mail_delete_message",
    {
      title: "Delete Mail Message",
      description: `Moves a message to the account's Trash/Deleted Items mailbox (standard Mail.app delete - not
instant permanent deletion, but the user's own Mail.app "Delete" action, so it can still be permanently removed later
by emptying trash).

Args:
  - account_name, mailbox_name (string): where the message lives (mailbox_name defaults to "INBOX")
  - message_id (string): from mail_list_messages

Returns: "Deleted message '<subject>'" on success, or "Error: Message not found".`,
      inputSchema: DeleteMessageInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async (params: z.infer<typeof DeleteMessageInput>) => {
      const script = `
        (function () {
          const app = Application('Mail');
          const params = ${toJXALiteral(params)};
          const accounts = app.accounts.whose({ name: params.account_name })();
          if (accounts.length === 0) return JSON.stringify({ error: "Account '" + params.account_name + "' not found" });
          const boxes = accounts[0].mailboxes.whose({ name: params.mailbox_name })();
          if (boxes.length === 0) return JSON.stringify({ error: "Mailbox '" + params.mailbox_name + "' not found" });
          const mailbox = boxes[0];
          const total = Math.min(mailbox.messages.length, params.scan_limit);
          for (let i = 0; i < total; i++) {
            let m;
            try { m = mailbox.messages[i]; } catch (e) { continue; }
            if (String(m.id()) !== params.message_id) continue;
            const subject = m.subject() || "";
            app.delete(m);
            return JSON.stringify({ subject: subject });
          }
          return JSON.stringify({ error: "Message not found" });
        })()
      `;
      const result = await runJXAJson<{ subject?: string; error?: string }>(script, 30_000);
      if (result.error) return textContent(`Error: ${result.error}`);
      return textContent(`Deleted message '${result.subject}'`);
    }
  );

  // ---------------------------------------------------------------------
  // mail_create_draft
  // ---------------------------------------------------------------------
  const CreateDraftInput = z
    .object({
      to: z.array(z.string()).min(1).describe("Recipient email addresses."),
      subject: z.string().min(1).describe("Email subject."),
      body: z.string().describe("Plain-text email body."),
      cc: z.array(z.string()).optional().describe("CC email addresses."),
      account_name: z
        .string()
        .optional()
        .describe("Which account to send from. Omit to use Mail.app's default account.")
    })
    .strict();

  server.registerTool(
    "mail_create_draft",
    {
      title: "Create Mail Draft",
      description: `Creates a new email as a draft/compose window WITHOUT sending it - the user reviews and sends it
themselves from Mail.app. This is the safe default for composing email; use mail_send_message only when the user has
explicitly asked for the email to go out immediately without review.

Args:
  - to (string[]): recipient addresses
  - subject (string)
  - body (string): plain text
  - cc (string[], optional)
  - account_name (string, optional): which account to send from, omit for Mail.app's default

Returns: "Created draft '<subject>' to <recipients>". The compose window opens visibly in Mail.app.

Error Handling:
  - Returns "Error: Account '<name>' not found" if account_name is given but doesn't match exactly.`,
      inputSchema: CreateDraftInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (params: z.infer<typeof CreateDraftInput>) => {
      const script = `
        (function () {
          const app = Application('Mail');
          const params = ${toJXALiteral(params)};
          if (params.account_name) {
            const accounts = app.accounts.whose({ name: params.account_name })();
            if (accounts.length === 0) return JSON.stringify({ error: "Account '" + params.account_name + "' not found" });
          }
          const msg = app.OutgoingMessage().make({ withProperties: { subject: params.subject, content: params.body, visible: true } });
          for (const addr of params.to) {
            msg.toRecipients.push(app.ToRecipient().make({ withProperties: { address: addr } }));
          }
          if (params.cc) {
            for (const addr of params.cc) {
              msg.ccRecipients.push(app.CcRecipient().make({ withProperties: { address: addr } }));
            }
          }
          if (params.account_name) {
            const accounts = app.accounts.whose({ name: params.account_name })();
            try { msg.sender = accounts[0].emailAddresses()[0]; } catch (e) {}
          }
          return JSON.stringify({ subject: params.subject, to: params.to.join(', ') });
        })()
      `;
      const result = await runJXAJson<{ subject?: string; to?: string; error?: string }>(script);
      if (result.error) return textContent(`Error: ${result.error}`);
      return textContent(`Created draft '${result.subject}' to ${result.to}. Review it in the Mail.app compose window and send it from there.`);
    }
  );

  // ---------------------------------------------------------------------
  // mail_send_message
  // ---------------------------------------------------------------------
  const SendMessageInput = z
    .object({
      to: z.array(z.string()).min(1).describe("Recipient email addresses."),
      subject: z.string().min(1).describe("Email subject."),
      body: z.string().describe("Plain-text email body."),
      cc: z.array(z.string()).optional().describe("CC email addresses."),
      account_name: z
        .string()
        .optional()
        .describe("Which account to send from. Omit to use Mail.app's default account.")
    })
    .strict();

  server.registerTool(
    "mail_send_message",
    {
      title: "Send Mail Message",
      description: `Composes and immediately SENDS an email - there is no review step and this cannot be undone once
sent. Only use this when the user has explicitly and unambiguously asked for the email to be sent right away. If
there's any doubt, use mail_create_draft instead so the user can review it first.

Args:
  - to (string[]): recipient addresses
  - subject (string)
  - body (string): plain text
  - cc (string[], optional)
  - account_name (string, optional): which account to send from, omit for Mail.app's default

Returns: "Sent '<subject>' to <recipients>".

Error Handling:
  - Returns "Error: Account '<name>' not found" if account_name is given but doesn't match exactly.
  - If Mail.app is not signed in / offline, the message may queue in Mail's own Outbox rather than fail outright -
    this tool cannot distinguish "sent" from "queued to send" since that's how Mail.app's own scripting works.`,
      inputSchema: SendMessageInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async (params: z.infer<typeof SendMessageInput>) => {
      const script = `
        (function () {
          const app = Application('Mail');
          const params = ${toJXALiteral(params)};
          if (params.account_name) {
            const accounts = app.accounts.whose({ name: params.account_name })();
            if (accounts.length === 0) return JSON.stringify({ error: "Account '" + params.account_name + "' not found" });
          }
          const msg = app.OutgoingMessage().make({ withProperties: { subject: params.subject, content: params.body, visible: false } });
          for (const addr of params.to) {
            msg.toRecipients.push(app.ToRecipient().make({ withProperties: { address: addr } }));
          }
          if (params.cc) {
            for (const addr of params.cc) {
              msg.ccRecipients.push(app.CcRecipient().make({ withProperties: { address: addr } }));
            }
          }
          if (params.account_name) {
            const accounts = app.accounts.whose({ name: params.account_name })();
            try { msg.sender = accounts[0].emailAddresses()[0]; } catch (e) {}
          }
          msg.send();
          return JSON.stringify({ subject: params.subject, to: params.to.join(', ') });
        })()
      `;
      const result = await runJXAJson<{ subject?: string; to?: string; error?: string }>(script, 30_000);
      if (result.error) return textContent(`Error: ${result.error}`);
      return textContent(`Sent '${result.subject}' to ${result.to}`);
    }
  );
}
