import { Message, callGptApi } from "@/lib/gptApi";
import {
  ParsedJson,
  askUserMultiLine,
  askUserSingleLine,
  execPromise,
  mkdirP,
  parseGptJson,
  parsedJsonSchema,
  pathIsFile,
  safePathJoin,
} from "@/lib/util";
import { z } from "zod";
import * as fsPromises from "fs/promises";
import path from "path";
import { zodToJsonSchema } from "zod-to-json-schema";

// read system prompt from `../system_prompt.md` relative to this file
const SYSTEM_PROMPT_PROMISE = fsPromises
  .readFile(path.join(__dirname, "../system_prompt.md"), "utf-8")
  .then((s) => s.trim());

type Context = {
  codePath: string;
  fireblocksApiKey: string;
};

const GPT_FUNCTIONS = [
  {
    name: "list_files",
    description: "List all files, recursively, in the project",
    parametersSchema: z.object({}),
    execute: async (context: Context, args: {}) => {
      console.log("Listing files...");
      const result = (
        await execPromise(`cd ${context.codePath} && tree --gitignore .`)
      ).stdout.trim();
      console.log(
        `Returning file listing of ${result.split("\n").length} lines.`
      );
      return result;
    },
  },

  {
    name: "read_file",
    description: "Read a file",
    parametersSchema: z.object({
      path: z.string().describe("Path relative to the project root"),
    }),
    execute: async (context: Context, args: { path: string }) => {
      console.log(`Reading file ${args.path}...`);
      const filePath = safePathJoin(context.codePath, args.path);
      if (!(await pathIsFile(filePath))) {
        return "<file does not exist>";
      } else {
        return await fsPromises.readFile(filePath, "utf-8");
      }
    },
  },

  {
    name: "write_file",
    description:
      "Write or overwrite file. Delete if content empty. Directories will be automatically created as needed.",
    parametersSchema: z.object({
      path: z.string().describe("Path relative to project."),
      content: z.string().describe("Content to write."),
    }),
    execute: async (
      context: Context,
      args: { path: string; content: string }
    ) => {
      console.log(`Writing file ${args.path}...`);

      const filePath = safePathJoin(context.codePath, args.path);
      const dirPath = path.dirname(filePath);

      // if content is empty, delete the file if it exists
      if (!args.content.trim()) {
        if (await pathIsFile(filePath)) {
          await fsPromises.rm(filePath);
        }
      } else {
        await mkdirP(dirPath);
        await fsPromises.writeFile(filePath, args.content);
      }
      return "<done>";
    },
  },

  {
    name: "run",
    description: "Run command in bash.",
    parametersSchema: z.object({
      command: z.string().describe(`Bash command to run.`),
    }),
    execute: async (context: Context, args: { command: string }) => {
      console.log(`GPT wants to run command:\n\n  ${args.command}\n`);
      const userResponse = await askUserSingleLine(
        "Do you want to run this command?"
      );

      console.log();

      if (!userResponse.toLowerCase().startsWith("y")) {
        console.log("Canceled.");
        return "<user canceled request>";
      }

      console.log("Running command...\n");

      let execRes;
      let resPrefix = "";
      try {
        execRes = await execPromise(args.command, {
          cwd: context.codePath,
        });
        resPrefix = `<done>\n\n`;
      } catch (e) {
        try {
          const errorDetails = z
            .object({
              code: z.number(),
              stdout: z.string(),
              stderr: z.string(),
            })
            .parse(e);
          resPrefix = `<failed with code ${errorDetails.code}>\n\n`;
          execRes = errorDetails;
        } catch (parseError) {
          throw e;
        }
      }
      return (
        `${resPrefix}${execRes.stdout.trim()}` +
        (execRes.stderr.trim() ? `\n\nstderr:\n\n${execRes.stderr.trim()}` : "")
      ).trim();
    },
  },

  {
    name: "make_http_request",
    description: "Make an HTTP request.",
    parametersSchema: z.object({
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      url: z.string().describe("URL to query."),
      headers: z.record(z.string()).describe("Headers to send.").optional(),
      body: z.any().describe("Body to send.").optional(),
    }),
    execute: async (
      context: Context,
      args: {
        method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
        url: string;
        headers: Record<string, string>;
        body?: ParsedJson;
      }
    ) => {
      console.log(`Making request to ${args.url}...`);
      const fetchResult = await fetch(args.url, {
        method: args.method,
        headers: args.headers,
        body: args.body ? JSON.stringify(args.body) : undefined,
      });
      const result = await fetchResult.text();
      const statusCode = fetchResult.status;
      console.log(`Got response with status code ${statusCode}.`);
      return `Status code: ${statusCode}\n\nResponse:\n\n${result}`;
    },
  },

  {
    name: "complete_request",
    description: "Complete the request.",
    parametersSchema: z.object({
      summary: z.string().describe("Summary to the user of what was done"),
    }),
    execute: async (context: Context, args: { summary: string }) => {
      console.log(args.summary);
      console.log("\n=== Request complete ===\n");
      return "<end_conversation>";
    },
  },
];

const FUNCTION_DEFINITIONS_FOR_GPT = GPT_FUNCTIONS.map((fn) => ({
  name: fn.name,
  description: fn.description,
  parameters: zodToJsonSchema(fn.parametersSchema),
}));

async function getSystemPrompt(context: Context) {
  const result = (await SYSTEM_PROMPT_PROMISE).replace(
    "{{fireblocksApiKey}}",
    context.fireblocksApiKey
  );

  return result;
}

async function handleFunctionCall(
  context: Context,
  functionCall: {
    name: string;
    arguments: string;
  }
): Promise<string> {
  // console.log("tk: functionCall raw: ", JSON.stringify(functionCall, null, 2));

  const fn = GPT_FUNCTIONS.find((fn) => fn.name === functionCall.name);
  if (!fn) {
    throw new Error(`Function ${functionCall.name} not found.`);
  }

  let args: any;

  try {
    const rawParsedJson = parseGptJson(functionCall.arguments);
    args = fn.parametersSchema.parse(rawParsedJson);
  } catch (e) {
    // console.log("tk: bad args", e);
    return `<error parsing arguments>`;
  }

  const res = await fn.execute(context, args);

  return res;
}

async function handleUserRequest(context: Context, request: string) {
  let messages: Message[] = [
    { role: "system", content: await getSystemPrompt(context) },
    { role: "user", content: request },
    {
      role: "assistant",
      content: "First, let's list the files in the project.",
      function_call: { name: "list_files", arguments: "{}" },
    },
  ];

  while (true) {
    const lastMessage = messages[messages.length - 1]!;

    if (lastMessage.role === "assistant" && lastMessage.function_call) {
      console.log(
        `GPT wants to call a function: ${lastMessage.function_call.name}`
      );
      const functionRes: string = await handleFunctionCall(
        context,
        lastMessage.function_call
      );
      if (functionRes == "<end_conversation>") {
        return;
      }
      messages.push({
        role: "function",
        name: lastMessage.function_call.name,
        content: functionRes,
      });
      continue;
    }
    if (lastMessage.role === "assistant") {
      const userInput = await askUserSingleLine("Respond to GPT");
      messages.push({
        role: "user",
        content: userInput,
      });
      continue;
    }
    if (lastMessage.role === "user" || lastMessage.role === "function") {
      const gptRes = await callGptApi(
        messages,
        FUNCTION_DEFINITIONS_FOR_GPT,
        "gpt-4"
      );
      if (!gptRes.success) {
        console.log("gpt error:", gptRes.error);
        throw new Error("gpt failed");
      }
      const newMessage = gptRes.newMessage;
      messages.push(newMessage);
      if (newMessage.content) {
        console.log("GPT:");
        console.log(newMessage.content);
        console.log();
      }
      continue;
    }
    throw new Error("unreachable");
  }
}

async function main() {
  console.log(
    "===================================================================\nFirebuild -- let AI do the work for you integrating with Fireblocks\n===================================================================\n"
  );

  const codePath = await askUserSingleLine(
    "What is the path to your code directory?"
  );

  console.log();

  const fireblocksApiKey = await askUserSingleLine(
    "What is your Fireblocks API key?"
  );

  while (true) {
    console.log();
    const request = await askUserSingleLine("What do you want to do?");
    console.log();
    await handleUserRequest({ codePath, fireblocksApiKey }, request);
  }
}

main().then(() => {
  process.exit(0);
});
