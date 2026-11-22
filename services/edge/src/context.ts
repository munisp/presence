/** Shared service context for edge routes. */

import Postgres from "pg";
import { Redis as Valkey } from "ioredis";

export interface EdgeContext {
  pg: Postgres.Pool;
  valkey: Valkey;
  matchServiceUrl: string;
  centrifugoUrl: string;
  centrifugoApiKey: string;
}

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
  }
}

/** FR-23 suppression key — canonical pair ordering, ten-minute TTL. */
export function suppressionKey(a: string, b: string): string {
  return a < b ? `suppress:${a}:${b}` : `suppress:${b}:${a}`;
}

export const SUPPRESSION_TTL_S = 600; // FR-23
