import { run } from "./bot.js";

run().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
