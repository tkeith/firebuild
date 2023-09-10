export default async function asyncSleep(timeToSleepMs: number) {
  await new Promise((r) => setTimeout(r, timeToSleepMs));
}
