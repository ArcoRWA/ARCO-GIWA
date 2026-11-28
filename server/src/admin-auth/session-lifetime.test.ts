import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { FastifyRequest } from 'fastify';
import { SiweMessage } from 'siwe';
import { privateKeyToAccount } from 'viem/accounts';
import { buildApp, type AppEnv, type ArcoAppServices } from '../app.js';
import { parseAdminSessionOrigins, validateServerEnv } from '../config/env.js';
import { stocksSessionResolvers } from '../stocks-runtime/session.js';
import { adminSessionDomains, siweSessionWallet } from './session.js';

// ADMIN_SESSION_ORIGINS: sessions signed on an admin console domain last 60 minutes, every other
// domain keeps 15. The limit follows the token's signed `domain` claim.

const { sign, decode } = createRequire(import.meta.url)('jsonwebtoken') as typeof import('jsonwebtoken');
const SECRET = 'TEST_ONLY_SESSION_LIFETIME_SECRET';
const ADMIN = 'admin.example.test', APP = 'app.example.test';
const CORS = [`https://${ADMIN}`, `https://${APP}`];
const WALLET = '0x00000000000000000000000000000000000000a1';
const now = () => Math.floor(Date.now() / 1000);
const request = (claims: Record<string, unknown>) =>
  ({ headers: { authorization: `Bearer ${sign({ sub: WALLET, chainId: 91342, ...claims }, SECRET)}` } }) as unknown as FastifyRequest;
// A token signed `age` seconds ago that lives `lifetime` seconds.
const token = (domain: string, lifetime: number, age = 0) => request({ domain, iat: now() - age, exp: now() - age + lifetime });

const withAdmin = stocksSessionResolvers(SECRET, [ADMIN, APP], [], [ADMIN]);
const withoutAdmin = stocksSessionResolvers(SECRET, [ADMIN, APP], []);
const accepted = async (resolvers: typeof withAdmin, req: FastifyRequest) => (await resolvers.resolveActor(req)) !== null;

test('an admin-domain session is accepted for up to 60 minutes and rejected beyond', async () => {
  assert.equal(await accepted(withAdmin, token(ADMIN, 3600)), true, 'fresh 60-minute token');
  assert.equal(await accepted(withAdmin, token(ADMIN, 3600, 3590)), true, '59m50s old, still before exp');
  assert.equal(await accepted(withAdmin, token(ADMIN, 900)), true, 'a 15-minute admin token is fine too');
  assert.equal(await accepted(withAdmin, token(ADMIN, 3660)), false, '61-minute lifetime');
  assert.equal(await accepted(withAdmin, token(ADMIN, 3700, 3610)), false, 'signed 60m10s ago with a crafted exp still ahead');
  // The Vault admin check (siweSessionWallet) applies the same limit.
  const vault = siweSessionWallet(SECRET, CORS, [`https://${ADMIN}`]);
  assert.equal(await vault(token(ADMIN, 3600, 3000)), WALLET);
  assert.equal(await vault(token(ADMIN, 3660)), null);
});

test('an app-domain session stays at 15 minutes even with a crafted 60-minute lifetime', async () => {
  assert.equal(await accepted(withAdmin, token(APP, 900, 890)), true);
  assert.equal(await accepted(withAdmin, token(APP, 1020, 960)), false, 'signed 16 minutes ago');
  assert.equal(await accepted(withAdmin, token(APP, 3600)), false, 'app token with a 3600 s lifetime');
  assert.equal(await accepted(withAdmin, token(APP, 3600, 960)), false, 'app token, 16 minutes old, 3600 s lifetime');
  const vault = siweSessionWallet(SECRET, CORS, [`https://${ADMIN}`]);
  assert.equal(await vault(token(APP, 3600)), null);
});

test('nothing else is loosened: signature, chain, domain list and future iat still fail', async () => {
  const bad = [
    { headers: { authorization: `Bearer ${sign({ sub: WALLET, chainId: 91342, domain: ADMIN, iat: now(), exp: now() + 3600 }, 'WRONG_TEST_ONLY_SECRET')}` } } as unknown as FastifyRequest,
    request({ domain: ADMIN, chainId: 1, iat: now(), exp: now() + 3600 }),
    request({ domain: 'evil.example.test', iat: now(), exp: now() + 900 }),
    request({ domain: ADMIN, iat: now() + 60, exp: now() + 3600 }),
    token(ADMIN, 3600, 3700),
  ];
  for (const req of bad) assert.equal(await accepted(withAdmin, req), false);
  // An admin host that is not a CORS-listed signing domain is still refused.
  const unlisted = stocksSessionResolvers(SECRET, [APP], [], [ADMIN]);
  assert.equal(await accepted(unlisted, token(ADMIN, 900)), false);
});

test('without admin domains (ADMIN_SESSION_ORIGINS unset) every domain keeps the 15-minute limit', async () => {
  assert.equal(await accepted(withoutAdmin, token(ADMIN, 900, 890)), true);
  assert.equal(await accepted(withoutAdmin, token(ADMIN, 3600)), false);
  assert.equal(await accepted(withoutAdmin, token(APP, 3600)), false);
  const vault = siweSessionWallet(SECRET, CORS);
  assert.equal(await vault(token(ADMIN, 900)), WALLET);
  assert.equal(await vault(token(ADMIN, 3600)), null);
});

test('ADMIN_SESSION_ORIGINS: only exact http(s) origins also in CORS_ALLOWED_ORIGINS count; others are ignored, never thrown', () => {
  assert.deepEqual(parseAdminSessionOrigins(undefined, CORS), { origins: [], ignored: [] });
  assert.deepEqual(parseAdminSessionOrigins('', CORS), { origins: [], ignored: [] });
  assert.deepEqual(parseAdminSessionOrigins(` https://${ADMIN} , https://${ADMIN}`, CORS), { origins: [`https://${ADMIN}`], ignored: [] });
  const mixed = parseAdminSessionOrigins(`https://${ADMIN},https://other.example.test,not a url,https://${APP}/path,*,ftp://${ADMIN}`, CORS);
  assert.deepEqual(mixed.origins, [`https://${ADMIN}`]);
  assert.deepEqual(mixed.ignored, ['https://other.example.test', 'not a url', `https://${APP}/path`, '*', `ftp://${ADMIN}`]);
  // A buildApp env that names an origin outside the CORS list gains nothing either.
  assert.deepEqual(adminSessionDomains(['https://other.example.test', `https://${ADMIN}`], CORS), [ADMIN]);
  assert.deepEqual(adminSessionDomains(undefined, CORS), []);

  const base = { DATABASE_URL: 'postgres://x', DIRECT_URL: 'postgres://x', INDEXER_RPC_URL: 'http://rpc.invalid', AUTH_JWT_SECRET: 's', CORS_ALLOWED_ORIGINS: CORS.join(',') };
  const unset = validateServerEnv({ ...base });
  assert.deepEqual([unset.adminSessionOrigins, unset.adminSessionOriginsIgnored], [[], []]);
  const set = validateServerEnv({ ...base, ADMIN_SESSION_ORIGINS: `https://${ADMIN},https://not-in-cors.example.test` });
  assert.deepEqual(set.adminSessionOrigins, [`https://${ADMIN}`]);
  assert.deepEqual(set.adminSessionOriginsIgnored, ['https://not-in-cors.example.test']);
});

// ── /api/v1/auth/verify issues the matching lifetime ───────────────────────

function app(adminSessionOrigins: readonly string[] | undefined) {
  const nonces = new Map<string, { walletAddress: string; domain: string }>();
  const arco = {
    async issueAuthNonce(input: { walletAddress: string; domain: string; nonce: string }) { nonces.set(input.nonce, { walletAddress: input.walletAddress, domain: input.domain }); },
    async consumeAuthNonce(input: { walletAddress: string; domain: string; nonce: string }) {
      const row = nonces.get(input.nonce);
      nonces.delete(input.nonce);
      return Boolean(row && row.walletAddress === input.walletAddress.toLowerCase() && row.domain === input.domain);
    },
  };
  const env: AppEnv = {
    corsAllowedOrigins: CORS, authNonceTtlSeconds: 60, authJwtSecret: SECRET, registryPath: '/NO_REGISTRY',
    adminOperators: [], adminOperatorToken: '',
    ...(adminSessionOrigins ? { adminSessionOrigins } : {}),
  };
  const services = { arco, registry: { listNetworks: async () => [] }, portfolio: {}, readiness: { check: async () => ({ ok: true, checks: {} }) } } as unknown as ArcoAppServices;
  return buildApp(env, services);
}

async function signIn(server: ReturnType<typeof app>, domain: string) {
  const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945384dbb2c0f25b563eab2bfb184c3f8816d1');
  const nonce = await server.inject({ method: 'POST', url: '/api/v1/auth/nonce', payload: { walletAddress: account.address, domain } });
  assert.equal(nonce.statusCode, 200);
  const message = new SiweMessage({ domain, address: account.address, statement: 'Sign in', uri: `https://${domain}`, version: '1', chainId: 91342, nonce: nonce.json().nonce }).prepareMessage();
  const response = await server.inject({ method: 'POST', url: '/api/v1/auth/verify', payload: { message, signature: await account.signMessage({ message }) } });
  assert.equal(response.statusCode, 200);
  const body = response.json() as { token: string; expiresIn: number };
  const claims = decode(body.token) as { iat: number; exp: number; domain: string };
  return { expiresIn: body.expiresIn, lifetime: claims.exp - claims.iat, domain: claims.domain, token: body.token };
}

test('verify issues 60 minutes for an admin console domain and 15 for the app; expiresIn matches the token', async t => {
  const server = app([`https://${ADMIN}`]); t.after(() => server.close());
  const admin = await signIn(server, ADMIN);
  assert.deepEqual([admin.expiresIn, admin.lifetime, admin.domain], [3600, 3600, ADMIN]);
  const appSession = await signIn(server, APP);
  assert.deepEqual([appSession.expiresIn, appSession.lifetime, appSession.domain], [900, 900, APP]);
  // The issued admin token passes the admin session route.
  const session = await server.inject({ method: 'GET', url: '/api/v1/admin/session', headers: { authorization: `Bearer ${admin.token}` } });
  assert.equal(session.statusCode, 200);
});

test('verify keeps 15 minutes everywhere when ADMIN_SESSION_ORIGINS is unset or names an origin outside CORS', async t => {
  for (const origins of [undefined, [], ['https://not-in-cors.example.test']]) {
    const server = app(origins); t.after(() => server.close());
    const admin = await signIn(server, ADMIN);
    assert.deepEqual([admin.expiresIn, admin.lifetime], [900, 900], JSON.stringify(origins));
  }
  // An origin outside CORS whose host is the signing domain still gains nothing.
  const server = app(['https://other.example.test']); t.after(() => server.close());
  assert.equal((await signIn(server, 'other.example.test')).expiresIn, 900);
});
