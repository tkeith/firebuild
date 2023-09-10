import { z } from "zod";
import asyncSleep from "./asyncSleep";
import { JsonSchema7Type } from "zod-to-json-schema/src/parseDef";
import "dotenv/config";
import { parsedJsonSchema } from "./util";

/*
The goal of this file is to handle calls to the GPT API with basic data validation (up to and including parsing the JSON response from GPT).
It does not check that function calls make sense (correct name and arguments).
Retry logic for 500 and network errors.
*/

const OPENAI_KEY = z.string().parse(process.env.OPENAI_KEY);

const systemMessageSchema = z.object({
  role: z.literal("system"),
  content: z.string(),
});

const userMessageSchema = z.object({
  role: z.literal("user"),
  content: z.string(),
});

const functionCallSchema = z.object({
  name: z.string(),
  arguments: z.string(),
});

const assistantMessageSchemaWithFunctionCall = z.object({
  role: z.literal("assistant"),
  content: z.string(),
  function_call: functionCallSchema,
});

export type AssistantMessageWithFunctionCall = z.infer<
  typeof assistantMessageSchemaWithFunctionCall
>;

const assistantMessageSchemaWithoutFunctionCall = z.object({
  role: z.literal("assistant"),
  content: z.string(),
  function_call: z.undefined(),
});

const assistantMessageSchema = z.union([
  assistantMessageSchemaWithFunctionCall,
  assistantMessageSchemaWithoutFunctionCall,
]);

export type AssistantMessage = z.infer<typeof assistantMessageSchema>;

const functionMessageSchema = z.object({
  role: z.literal("function"),
  name: z.string(),
  content: z.string(),
});

export const messageSchema = z.union([
  systemMessageSchema,
  userMessageSchema,
  assistantMessageSchema,
  functionMessageSchema,
]);

export type Message = z.infer<typeof messageSchema>;

export const functionDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: parsedJsonSchema, // TODO: this is not as restrictive as `FunctionDefinition`
});

export type FunctionDefinition = {
  name: string;
  description: string;
  parameters: JsonSchema7Type;
};

export type FailureResult = {
  success: false;
  error: "exceededTokenLimit";
};

type Result =
  | FailureResult
  | {
      success: true;
      newMessage: AssistantMessage;
      messages: Message[];
    };

type Model = "gpt-4" | "gpt-4-32k";

function undefinedIfZeroLength<T extends { length: number }>(x: T) {
  if (x.length === 0) {
    return undefined;
  }
  return x;
}

export async function callGptApi(
  messages: Message[],
  functions: FunctionDefinition[],
  model: Model
): Promise<Result> {
  let response;

  const totalTries = 3;
  let triesLeft = totalTries;

  while (true) {
    let doNotRetry = false;
    try {
      console.log("Asking GPT...");

      doNotRetry = false;

      const requestBody = JSON.stringify({
        // messages: [
        //   { role: "system", content: "you are a poem writer" },
        //   { role: "user", content: "write me a poem about bitcoin" },
        // ],
        messages: messages.map((message) => messageSchema.parse(message)),
        temperature: 0,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
        model: model,
        functions: undefinedIfZeroLength(
          functions.map((functionDefinition) =>
            functionDefinitionSchema.parse(functionDefinition)
          )
        ),
      });

      response = await fetch("https://api.openai.com/v1/chat/completions", {
        headers: {
          Authorization: "Bearer " + OPENAI_KEY,
          "Content-Type": "application/json",
        },
        body: requestBody,
        method: "POST",
      });

      if (!response.ok) {
        console.log(response.status);
        console.log(await response.text());
        if (response.status >= 400 && response.status < 500) {
          doNotRetry = true;
        }
        throw new Error("response not ok");
      }

      break;
    } catch (e) {
      console.log(e);

      if (doNotRetry) {
        console.log("not a retryable error");
        throw e;
      }

      if (triesLeft > 0) {
        console.log("retrying...");
        triesLeft -= 1;
        await asyncSleep(1000 * (totalTries - triesLeft));
        continue;
      } else {
        console.log("giving up");
        throw e;
      }
    }
  }
  const choice = z
    .object({ choices: z.array(z.unknown()) })
    .parse(await response.json()).choices[0];
  if (choice === undefined) {
    throw new Error("No response from GPT.");
  }

  let parsedChoice;
  try {
    parsedChoice = z
      .union([
        z.object({ finish_reason: z.literal("length") }),
        z.object({
          finish_reason: z.literal("stop"),
          message: z.object({
            content: z.string(),
            role: z.literal("assistant"),
            function_call: z.undefined(),
          }),
        }),
        z.object({
          finish_reason: z.literal("function_call"),
          message: z.object({
            content: z
              .string()
              .nullable()
              .transform((x) => (x == null ? "" : x)),
            role: z.literal("assistant"),
            function_call: z.object({
              name: z.string(),
              arguments: z.string(),
            }),
          }),
        }),
      ])
      .parse(choice);
  } catch (e) {
    console.log(choice);
    throw e;
  }

  if (parsedChoice.finish_reason === "length") {
    return { success: false, error: "exceededTokenLimit" };
  }

  function getReturnValue(newMessage: AssistantMessage): Result {
    return {
      success: true,
      newMessage,
      messages: [...messages, newMessage],
    };
  }

  if (parsedChoice.finish_reason === "stop") {
    return getReturnValue({
      role: "assistant",
      content: parsedChoice.message.content,
    });
  }
  if (parsedChoice.finish_reason === "function_call") {
    return getReturnValue({
      role: "assistant",
      content: parsedChoice.message.content,
      function_call: {
        name: parsedChoice.message.function_call.name,
        arguments: parsedChoice.message.function_call.arguments,
      },
    });
  }

  throw new Error(
    "GPT had unexpected finish reason: " + parsedChoice.finish_reason
  );
}
