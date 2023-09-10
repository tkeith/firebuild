import { exec, execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fsPromises from "fs/promises";
import { z } from "zod";
import readline from "readline";

export const execPromise = promisify(exec);

export const execFilePromise = promisify(execFile);

export function safePathJoin(base: string, target: string) {
  // Resolves to an absolute path
  const targetPath = path.join(base, target);

  // Checks if resolved path is still within the base directory
  if (!targetPath.startsWith(base)) {
    throw new Error("Upward traversal outside of `base` not allowed");
  }

  return targetPath;
}

export async function pathAccessible(path: string) {
  try {
    await fsPromises.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function pathIsFile(path: string) {
  try {
    const stat = await fsPromises.stat(path);
    const isFile = stat.isFile();
    return isFile;
  } catch (e) {
    return false;
  }
}

export async function pathIsDir(path: string) {
  try {
    const stat = await fsPromises.stat(path);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

// emulate the mkdir -p behavior
export async function mkdirP(path: string) {
  const pathParts = path.split("/");
  for (let i = 0; i < pathParts.length; i++) {
    const partialPath = pathParts.slice(0, i + 1).join("/");
    if (partialPath === "") {
      continue;
    }
    if (!(await pathIsDir(partialPath))) {
      if (await pathAccessible(partialPath)) {
        throw Error(
          `path ${partialPath} already exists and is not a directory`
        );
      }
      await fsPromises.mkdir(partialPath);
    }
  }
}

export const parsedJsonSchema: z.ZodSchema<ParsedJson> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(parsedJsonSchema),
    z.record(parsedJsonSchema),
  ])
);

export type ParsedJson =
  | boolean
  | number
  | string
  | null
  | ParsedJson[]
  | { [key: string]: ParsedJson };

function preprocessGptJson(jsonString: string) {
  let insideString = false;
  let result = "";
  let wasBackslash = false; // track if the previous character was a backslash

  for (let i = 0; i < jsonString.length; i++) {
    const char = jsonString[i];

    if (char === '"' && !wasBackslash) {
      insideString = !insideString;
    }

    if (insideString && (char === "\n" || char === "\r")) {
      result += "\\n";
    } else {
      result += char;
    }

    wasBackslash = char === "\\";
  }

  return result;
}

export function parseGptJson(jsonString: string) {
  const preprocessedString = preprocessGptJson(jsonString);
  return parsedJsonSchema.parse(JSON.parse(preprocessedString));
}

export async function askUserMultiLine(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let request: string[] = [];

  return new Promise((resolve, reject) => {
    rl.on("line", (input: string) => {
      if (input === ".") {
        rl.close();
        resolve(request.join("\n"));
      } else {
        request.push(input);
      }
    });

    rl.on("error", (err: Error) => {
      reject(err);
    });

    console.log(`${question} (end with a single dot on a line):`);
  });
}

export async function askUserSingleLine(
  question: string,
  allowEmpty: boolean = false,
  trim: boolean = true
): Promise<string> {
  while (true) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    let result = await new Promise<string>((resolve, reject) => {
      rl.on("line", (input: string) => {
        rl.close();
        resolve(input);
      });

      rl.on("error", (err: Error) => {
        reject(err);
      });

      console.log(`${question} (respond and hit enter):`);
    });
    if (trim) {
      result = result.trim();
    }
    if (result === "" && !allowEmpty) {
      console.log("<empty response not allowed>\n");
      continue;
    }
    return result;
  }
}

export async function spinner<T>(promise: Promise<T>): Promise<T> {
  const spinnerChars = ["|", "/", "-", "\\"];
  let i = 0;

  const interval = setInterval(() => {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(spinnerChars[i]!);
    i = (i + 1) % spinnerChars.length;
  }, 100);

  try {
    const result = await promise;
    clearInterval(interval);
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    return result;
  } catch (error) {
    clearInterval(interval);
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    throw error;
  }
}
