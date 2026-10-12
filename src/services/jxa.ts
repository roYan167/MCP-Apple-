import { spawn } from "node:child_process";

/**
 * Runs a JavaScript for Automation (JXA) script via `osascript -l JavaScript`
 * and returns whatever the script prints to stdout.
 *
 * Convention used throughout this project: every JXA script we build is an
 * IIFE whose final statement is `JSON.stringify(result)`. That way the
 * script's own stdout is always a single JSON value we can parse here, and
 * callers never have to deal with AppleScript's ad-hoc text output format.
 *
 * The script is piped in via stdin (not passed as a CLI arg) to avoid
 * shell-escaping issues and OS argument-length limits when scripts embed
 * long note/email bodies etc.
 */
export function runJXA(script: string, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-l", "JavaScript", "-"], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `osascript timed out after ${timeoutMs}ms. This usually means macOS is showing a permission dialog ` +
            `(Calendar/Notes/Reminders/Mail/Automation access) that needs to be approved manually the first time, ` +
            `or Terminal/Claude Desktop is missing Automation permission in System Settings > Privacy & Security > Automation.`
        )
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(
          new Error(
            "Could not find the 'osascript' binary. This server only works on macOS (it automates Calendar, " +
              "Notes, Reminders and Mail via AppleScript/JXA)."
          )
        );
        return;
      }
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(formatOsascriptError(stderr, code)));
        return;
      }
      resolve(stdout.trim());
    });

    child.stdin.write(script, "utf8");
    child.stdin.end();
  });
}

/**
 * Runs a JXA script and parses its stdout as JSON. This is the function
 * almost all tools should use.
 */
export async function runJXAJson<T>(script: string, timeoutMs?: number): Promise<T> {
  const raw = await runJXA(script, timeoutMs);
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(
      `Apple app returned output that could not be parsed as JSON. Raw output: ${raw.slice(0, 500)}`
    );
  }
}

function formatOsascriptError(stderr: string, code: number | null): string {
  const trimmed = stderr.trim();

  if (/Not authorized to send Apple events/i.test(trimmed)) {
    return (
      "macOS blocked this automation request (Not authorized to send Apple events). " +
      "Grant access under System Settings > Privacy & Security > Automation: find the app you're running this " +
      "MCP server through (e.g. 'Claude') and enable the checkboxes for Calendar, Notes, Reminders and Mail."
    );
  }
  if (/Application isn.t running/i.test(trimmed) || /Can.t get application/i.test(trimmed)) {
    return `The target application is not available: ${trimmed}`;
  }

  return `osascript exited with code ${code}: ${trimmed || "(no error output)"}`;
}

/**
 * Safely embeds a JS value as a literal inside a generated JXA script.
 * We rely on JSON.stringify producing valid JavaScript syntax for the
 * plain data types (strings, numbers, booleans, null, arrays, objects)
 * this project passes around. ISO date strings are passed through as
 * strings and turned into `Date` objects inside the JXA script itself
 * with `new Date(isoString)`.
 */
export function toJXALiteral(value: unknown): string {
  return JSON.stringify(value);
}
