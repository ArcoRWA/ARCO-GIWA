import { createRequire } from 'node:module';
import type { FastifyRequest } from 'fastify';
import { address, type Actor, type Operator } from '../stocks/contracts.js';
import { parseStocksOperators, type NamedOperator } from './operators.js';
export type { NamedOperator } from './operators.js';

const require = createRequire(import.meta.url);
const { verify } = require('jsonwebtoken') as typeof import('jsonwebtoken');

/** Longest session lifetime, in seconds, for a token signed on an app domain (15 minutes). */
export const SESSION_MAX_SECONDS = 900;
/** Longest session lifetime, in seconds, for a token signed on an admin console domain (60 minutes). */
export const ADMIN_SESSION_MAX_SECONDS = 3600;

/** The longest lifetime /api/v1/auth/verify issues and every resolver accepts for a signing domain. */
export function sessionMaxSeconds(domain: string, adminDomains: ReadonlySet<string>): number {
  return adminDomains.has(domain) ? ADMIN_SESSION_MAX_SECONDS : SESSION_MAX_SECONDS;
}

// The existing SIWE endpoint issues a short-lived HS256 wallet session. A legacy
// shared operator token is deliberately not a Stocks operator identity. The lifetime
// limit follows the token's signed `domain` claim: 60 minutes for a domain in
// adminDomains (ADMIN_SESSION_ORIGINS), 15 minutes for every other domain.
export function stocksSessionResolvers(secret: string, domains: readonly string[], operators: readonly NamedOperator[], adminDomains: readonly string[] = []) {
  const allowedDomains = new Set(domains);
  const longDomains = new Set(adminDomains);
  const directory = new Map(parseStocksOperators(operators).map(op => [op.wallet, { operatorId: op.operatorId, permissions: op.permissions }]));
  async function resolveActor(request: FastifyRequest): Promise<Actor | null> {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    try {
      const value = verify(header.slice(7), secret, { algorithms: ['HS256'] });
      if (typeof value !== 'object' || value.chainId !== 91342 || typeof value.domain !== 'string' || !allowedDomains.has(value.domain)) return null;
      const now = Math.floor(Date.now() / 1000);
      const max = sessionMaxSeconds(value.domain, longDomains);
      if (typeof value.iat !== 'number' || typeof value.exp !== 'number' || value.exp <= now || value.iat > now + 5 || value.exp - value.iat > max || now - value.iat > max) return null;
      const wallet = address(String(value.sub));
      return { actorId: `evm:${wallet}`, wallet, chainId: 91342, scope: 'STOCKS_TESTNET', verified: true };
    } catch { return null; }
  }
  async function resolveOperator(request: FastifyRequest): Promise<Operator | null> {
    const actor = await resolveActor(request);
    const operator = actor ? directory.get(actor.wallet) : undefined;
    return operator ? { operatorId: operator.operatorId, permissions: [...operator.permissions] } : null;
  }
  return { resolveActor, resolveOperator };
}
