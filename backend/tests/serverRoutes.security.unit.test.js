import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Issue #2342: Security bypass via duplicate routes and missing Rate Limiters
// 1. All routes must be registered before app.listen().
// 2. Duplicate routes (/api/books, /api/jobs, /api/google-calendar, /api/courses)
//    must not exist.
// 3. /api/google-calendar and /api/roadmaps must be protected with generalLimiter.
// ---------------------------------------------------------------------------

let googleCalendarRoutes;
let roadmapRoutes;
let generalLimiter;

beforeAll(async () => {
  const gCalMod = await import("../routes/googleCalendarRoutes.js");
  googleCalendarRoutes = gCalMod.default ?? gCalMod;

  const rMapMod = await import("../routes/roadmapRoutes.js");
  roadmapRoutes = rMapMod.default ?? rMapMod;

  const rateLimiterMod = await import("../middlewares/rateLimiter.js");
  generalLimiter = rateLimiterMod.generalLimiter;
});

describe("server.js route registration and security integrity (#2342)", () => {
  const serverJsPath = path.resolve(__dirname, "../server.js");
  const serverJsContent = fs.readFileSync(serverJsPath, "utf-8");

  it("registers no routes after app.listen()", () => {
    const listenIndex = serverJsContent.indexOf("app.listen(");
    expect(listenIndex).toBeGreaterThan(-1);

    const postListenContent = serverJsContent.slice(listenIndex);
    const postListenRouteMatch = postListenContent.match(
      /app\.(use|get|post|put|patch|delete)\s*\(\s*["']\/api/
    );
    expect(postListenRouteMatch).toBeNull();
  });

  it("registers each API route exactly once", () => {
    const checkedRoutes = [
      "/api/books",
      "/api/jobs",
      "/api/courses",
      "/api/google-calendar",
      "/api/roadmaps",
    ];

    for (const route of checkedRoutes) {
      const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`app\\.use\\s*\\(\\s*["']${escaped}["']`, "g");
      const matches = serverJsContent.match(regex);
      expect(matches, `Expected exactly one registration for ${route}`).toHaveLength(1);
    }
  });

  it("binds generalLimiter to /api/roadmaps and /api/google-calendar in server.js", () => {
    expect(serverJsContent).toMatch(
      /app\.use\s*\(\s*["']\/api\/roadmaps["']\s*,\s*generalLimiter\s*,\s*roadmapRoutes\s*\)/
    );
    expect(serverJsContent).toMatch(
      /app\.use\s*\(\s*["']\/api\/google-calendar["']\s*,\s*generalLimiter\s*,\s*googleCalendarRoutes\s*\)/
    );
  });
});

describe("Google Calendar route rate limiting (#2342)", () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use("/api/google-calendar", generalLimiter, googleCalendarRoutes);
  });

  it("serves /api/google-calendar/connect with RateLimit headers", async () => {
    const res = await request(app).get("/api/google-calendar/connect");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: "Google Calendar connect route is working",
    });
    expect(res.headers["ratelimit-limit"]).toBeDefined();
    expect(res.headers["ratelimit-remaining"]).toBeDefined();
  });

  it("enforces rate limiting when request limit is exhausted", async () => {
    const customRateLimit = (await import("express-rate-limit")).default;
    const testLimiter = customRateLimit({
      windowMs: 60 * 1000,
      max: 2,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: "Too many requests" },
    });

    const testApp = express();
    testApp.use(express.json());
    testApp.use("/api/google-calendar", testLimiter, googleCalendarRoutes);

    const res1 = await request(testApp).get("/api/google-calendar/connect");
    expect(res1.status).toBe(200);

    const res2 = await request(testApp).get("/api/google-calendar/connect");
    expect(res2.status).toBe(200);

    const res3 = await request(testApp).get("/api/google-calendar/connect");
    expect(res3.status).toBe(429);
    expect(res3.body).toEqual({ error: "Too many requests" });
  });
});
