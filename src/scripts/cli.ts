import { callGptApi } from "@/lib/gptApi";

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
