import type { FastifyRequest } from 'fastify';
import { stocksSessionResolvers } from '../stocks-runtime/session.js';

/** SIWE signing domains accepted for sessions: the hosts of CORS_ALLOWED_ORIGINS. */
export function sessionDomains(corsAllowedOrigins: readonly string[]): string[] {
  return corsAllowedOrigins.map(origin => new URL(origin).host);
}

/**
 * Signing domains whose sessions may last 60 minutes: the hosts of the ADMIN_SESSION_ORIGINS
 * entries that are also in CORS_ALLOWED_ORIGINS (an entry outside the CORS list never counts).
 */
export function adminSessionDomains(adminSessionOrigins: readonly string[] | undefined, corsAllowedOrigins: readonly string[]): string[] {
  return (adminSessionOrigins ?? []).filter(origin => corsAllowedOrigins.includes(origin)).map(origin => new URL(origin).host);
}

/**
 * The one SIWE session check, shared with Stocks: an HS256 AUTH_JWT_SECRET session from
 * /api/v1/auth/verify, chain 91342, a CORS-listed signing domain and a lifetime of at most
 * 15 minutes (60 minutes for an admin console domain, see adminSessionDomains). Reuses the Stocks
 * resolver with an empty Stocks directory, so it works when the Stocks runtime is off and never
 * grants a Stocks permission. Returns the lowercase wallet.
 */
export function siweSessionWallet(secret: string, corsAllowedOrigins: readonly string[], adminSessionOrigins: readonly string[] = []) {
  const { resolveActor } = stocksSessionResolvers(secret, sessionDomains(corsAllowedOrigins), [], adminSessionDomains(adminSessionOrigins, corsAllowedOrigins));
  return async (request: FastifyRequest): Promise<string | null> => (await resolveActor(request))?.wallet ?? null;
}
