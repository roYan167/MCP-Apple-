// Response text over this size gets truncated with a clear note, so a single
// tool call can't blow up the model's context window (e.g. "list all notes"
// on a library with thousands of notes, or a huge email body).
export const CHARACTER_LIMIT = 25_000;

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;
