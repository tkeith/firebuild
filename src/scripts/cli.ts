import { Message, callGptApi } from "@/lib/gptApi";
import {
  askUserMultiLine,
  askUserSingleLine,
  execPromise,
  mkdirP,
  parseGptJson,
  pathIsFile,
  safePathJoin,
} from "@/lib/util";
import { z } from "zod";
import * as fsPromises from "fs/promises";
import path from "path";
import { zodToJsonSchema } from "zod-to-json-schema";

const SYSTEM_PROMPT = `\
# Overview

You are a programming AI designed to automatically help the user (programmer) to work with Fireblocks, a platform for managing cryptocurrency wallets. You will be using the Fireblocks NCW (non-custodial wallet) API. You can also help the user set up their local environment, for example by generating the certificate needed to interact with the Fireblocks API. When you are done helping a user, call the \`complete_request\` function.

# Here are some reference materials that may help

## Generate CSR file

  openssl req -new -newkey rsa:4096 -nodes -keyout fireblocks_secret.key -out fireblocks.csr -subj "/CN=My Fireblocks Certificate"

`;

type Context = {
  codePath: string;
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
      console.log(`GPT wants to run command:\n  ${args.command}`);
      const userResponse = await askUserSingleLine(
        "Do you want to run this command? (y/n)"
      );

      if (userResponse.toLowerCase() !== "y") {
        return "<user canceled request>";
      }

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

async function handleFunctionCall(
  context: Context,
  functionCall: {
    name: string;
    arguments: string;
  }
): Promise<string> {
  const fn = GPT_FUNCTIONS.find((fn) => fn.name === functionCall.name);
  if (!fn) {
    throw new Error(`Function ${functionCall.name} not found.`);
  }

  let args: any;

  try {
    const rawParsedJson = parseGptJson(functionCall.arguments);
    args = fn.parametersSchema.parse(rawParsedJson);
  } catch (e) {
    return `<error parsing arguments>`;
  }

  const res = await fn.execute(context, args);

  return res;
}

async function handleUserRequest(context: Context, request: string) {
  let messages: Message[] = [
    { role: "system", content: SYSTEM_PROMPT },
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
    if (
      lastMessage.role === "user" ||
      lastMessage.role === "function" ||
      lastMessage.role === "assistant"
    ) {
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
      console.log("GPT:");
      console.log(newMessage.content);
      console.log();
      continue;
    }
    throw new Error("unreachable");
  }
}

async function main() {
  const codePath = await askUserSingleLine(
    "What is the path to your code directory?"
  );

  while (true) {
    console.log("\n");
    const request = await askUserMultiLine("What do you want to do?");
    await handleUserRequest({ codePath }, request);
  }
}

main().then(() => {
  process.exit(0);
});
