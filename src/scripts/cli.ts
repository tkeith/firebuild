import { callGptApi } from "@/lib/gptApi";

// Replace this with your OpenAI API key
const OPENAI_API_KEY = process.env.OPENAI_KEY;

if (!OPENAI_API_KEY) {
  console.error("Please set the OPENAI_KEY environment variable.");
  process.exit(1);
}

// async function callGpt() {
//   const res = await fetch("https://api.openai.com/v1/chat/completions", {
//     headers: {
//       Authorization: "Bearer " + OPENAI_API_KEY,
//       "Content-Type": "application/json",
//     },
//     body: JSON.stringify({
//       messages: [
//         { role: "system", content: "you are a poem writer" },
//         { role: "user", content: "write me a poem about bitcoin" },
//       ],
//       temperature: 0,
//       top_p: 1,
//       frequency_penalty: 0,
//       presence_penalty: 0,
//       model: "gpt-4",
//     }),
//     method: "POST",
//   });
//   const choice = (await res.json()).choices[0];
//   console.log(choice);
// }

async function main() {
  const res = await callGptApi(
    [
      { role: "system", content: "you are a poem writer" },
      { role: "user", content: "write me a poem about bitcoin" },
    ],
    [],
    "gpt-4"
  );
  if (res.success) {
    console.log(res.newMessage);
  }
}

main().then(() => {
  process.exit(0);
});
