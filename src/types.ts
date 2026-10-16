export interface CalendarInfo {
  name: string;
  writable: boolean;
}

export interface CalendarEvent {
  id: string;
  calendar: string;
  title: string;
  startDate: string; // ISO 8601
  endDate: string; // ISO 8601
  allDay: boolean;
  location: string | null;
  notes: string | null;
  recurring?: boolean; // true for occurrences of a recurring series
}

export interface NoteFolderInfo {
  name: string;
}

export interface NoteSummary {
  id: string;
  folder: string;
  name: string;
  modificationDate: string; // ISO 8601
  preview: string;
}

export interface NoteDetail extends NoteSummary {
  body: string; // HTML, as stored by Notes.app
}

export interface ReminderListInfo {
  name: string;
}

export interface ReminderSummary {
  id: string;
  list: string;
  name: string;
  body: string | null;
  dueDate: string | null; // ISO 8601
  completed: boolean;
  priority: number; // 0 = none, 1 (high) - 9 (low), per Reminders.app scale
}

export interface MailAccountInfo {
  name: string;
  email: string | null;
}

export interface MailboxInfo {
  name: string;
  account: string;
  unreadCount: number;
}

export interface MailMessageSummary {
  id: string;
  mailbox: string;
  account: string;
  subject: string;
  sender: string;
  dateSent: string; // ISO 8601
  read: boolean;
  flagged: boolean;
  preview: string;
}

export interface MailMessageDetail extends MailMessageSummary {
  recipients: string[];
  body: string; // plain text
}

/** Truncates text to the shared CHARACTER_LIMIT with a clear trailing note. */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[... output truncated at ${limit} characters. Narrow your query (date range, folder/list/mailbox, search text, or limit) to see more.]`;
}
