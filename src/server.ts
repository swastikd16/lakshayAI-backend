import type { Request, Response } from "express";
import express from "express";
import cors from "cors";
import { env } from "./lib/env";
import { sendOk } from "./lib/response";
import { authRouter } from "./routes/auth";
import { onboardingRouter } from "./routes/onboarding";
import { dashboardRouter } from "./routes/dashboard";
import { plannerRouter } from "./routes/planner";
import { adaptiveRouter } from "./routes/adaptive";
import { doubtRouter } from "./routes/doubt";
import { revisionRouter } from "./routes/revision";
import { analyticsRouter } from "./routes/analytics";
import { profileRouter } from "./routes/profile";

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin: env.corsOrigin === "*" ? true : env.corsOrigin,
      credentials: true
    })
  );
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req: Request, res: Response) => sendOk(res, { status: "ok" }));

  app.use("/auth", authRouter);
  app.use("/onboarding", onboardingRouter);
  app.use("/dashboard", dashboardRouter);
  app.use("/planner", plannerRouter);
  app.use("/adaptive", adaptiveRouter);
  app.use("/doubt", doubtRouter);
  app.use("/revision", revisionRouter);
  app.use("/analytics", analyticsRouter);
  app.use("/profile", profileRouter);

  return app;
}
