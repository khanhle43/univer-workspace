import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type {
  ISessionTicketStore,
  SessionTicketRecord,
} from "@univerjs-pro/collaboration-endpoint";
import type { CustomData } from "@univerjs-pro/collaboration-service";
import { logger } from "../../logging/logger.js";

/**
 * Shared, Postgres-backed session ticket store.
 *
 * The collaboration Endpoint issues a one-time opaque ticket on the
 * `GET /universer-api/user/session-ticket` HTTP request and consumes it on the
 * WebSocket handshake. When HTTP requests and WebSocket upgrades are served by
 * different processes (e.g. a Vercel serverless front for HTTP and a long-running
 * realtime server for WebSocket), an in-memory store cannot be shared, so the
 * ticket must live in the database both processes can reach.
 *
 * `consume` uses `DELETE ... RETURNING` so a ticket is consumed exactly once:
 * the row is removed atomically and the record is returned in the same statement.
 * Expired tickets are ignored (and swept by a periodic timer).
 */
export class PostgresSessionTicketStore implements ISessionTicketStore {
  private readonly pool: Pool;
  private sweeper: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  constructor(connectionString: string, poolMax = 2) {
    this.pool = new Pool({ connectionString, max: poolMax });
    this.pool.on("error", (error) =>
      logger.warn({ code: "code" in error ? error.code : undefined }, "Idle session-ticket PostgreSQL connection lost")
    );
  }

  async issue(record: SessionTicketRecord, ttlMs: number): Promise<string> {
    const ticket = randomUUID();
    const now = Date.now();
    const expiresAt = now + ttlMs;
    await this.pool.query(
      `INSERT INTO session_tickets (ticket, user_id, custom_data, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [ticket, record.userID, JSON.stringify(record.customData), expiresAt, now],
    );
    return ticket;
  }

  async consume(ticket: string): Promise<SessionTicketRecord | null> {
    const { rows } = await this.pool.query<{
      ticket: string;
      user_id: string;
      custom_data: string;
    }>(
      `DELETE FROM session_tickets
       WHERE ticket = $1 AND expires_at > $2
       RETURNING ticket, user_id, custom_data`,
      [ticket, Date.now()],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      userID: row.user_id,
      customData: JSON.parse(row.custom_data) as CustomData,
    };
  }

  /** Remove expired tickets so the table does not grow without bound. */
  startSweeper(intervalMs = 60_000): void {
    if (this.sweeper || this.disposed) return;
    this.sweeper = setInterval(() => {
      void this.pool
        .query("DELETE FROM session_tickets WHERE expires_at <= $1", [Date.now()])
        .catch((error: unknown) =>
          logger.warn({ err: error }, "Session ticket sweep failed")
        );
    }, intervalMs);
    // Do not keep the process alive solely for the sweeper.
    this.sweeper.unref();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
    await this.pool.end();
  }
}
