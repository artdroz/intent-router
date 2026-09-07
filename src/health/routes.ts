import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { getDb } from "../store/db.js";

/** Liveness (`/health`) and readiness (`/ready`) endpoints. */
export function healthRoutes(app: FastifyInstance) {
  // Liveness — the process is up and serving requests.
  app.get("/health", () => ({ status: "ok" }));

  // Readiness — required dependencies (the database) are reachable.
  app.get("/ready", async (req, reply) => {
    try {
      await getDb().execute(sql`SELECT 1`);
      return { status: "ready" };
    } catch (err) {
      req.log.error(err, "readiness check failed");
      return reply.status(503).send({ status: "unavailable" });
    }
  });
}
