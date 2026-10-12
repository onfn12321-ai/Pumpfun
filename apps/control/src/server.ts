import { timingSafeEqual } from "node:crypto";

import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";

import type { DurableRepository } from "../../../packages/storage/src/repository.js";

const revisionSchema = z.object({ expectedRevision: z.number().int().nonnegative(), reason: z.string().min(3).max(500) });
const haltSchema = revisionSchema.extend({ scope: z.enum(["entries", "all"]) });

function matchesToken(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const value = received.startsWith("Bearer ") ? received.slice(7) : "";
  const actualBytes = Buffer.from(value);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function createControlApp(repository: DurableRepository, wallet: string, token: string) {
  if (token.length < 24) throw new Error("control token must contain at least 24 characters");
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  app.use((request: Request, response: Response, next: NextFunction) => {
    if (!matchesToken(request.header("authorization"), token)) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });

  app.get("/status", async (_request, response, next) => {
    try { response.json(await repository.getStatus(wallet)); } catch (error) { next(error); }
  });
  app.post("/control/halt", async (request, response, next) => {
    try {
      const input = haltSchema.parse(request.body);
      const current = await repository.getOrCreateControl(wallet, "paper");
      const updated = await repository.updateControl(wallet, input.expectedRevision, {
        entryHalt: true,
        executionHalt: input.scope === "all" ? true : current.executionHalt,
        reason: input.reason,
      });
      response.json(updated);
    } catch (error) { next(error); }
  });
  app.post("/control/liquidate", async (request, response, next) => {
    try {
      const input = revisionSchema.parse(request.body);
      response.json(await repository.requestLiquidation(wallet, input.expectedRevision, input.reason));
    } catch (error) { next(error); }
  });
  app.post("/control/resume", async (request, response, next) => {
    try {
      const input = revisionSchema.parse(request.body);
      const status = await repository.getStatus(wallet);
      if (status.pendingAttempts > 0) {
        response.status(409).json({ error: "pending attempts must be reconciled before resume" });
        return;
      }
      response.json(await repository.updateControl(wallet, input.expectedRevision, {
        entryHalt: false,
        executionHalt: false,
        reason: input.reason,
      }));
    } catch (error) { next(error); }
  });
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    response.status(400).json({ error: error instanceof Error ? error.message : "request failed" });
  });
  return app;
}
