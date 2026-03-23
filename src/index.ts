import { env } from "./lib/env";
import { createApp } from "./server";

process.on("unhandledRejection", (reason) => {
  // eslint-disable-next-line no-console
  console.error("Unhandled Promise Rejection:", reason);
});

process.on("uncaughtException", (error) => {
  // eslint-disable-next-line no-console
  console.error("Uncaught Exception:", error);
});

const app = createApp();

app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`LakshayAI backend running on port ${env.port}`);
});
