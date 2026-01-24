import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';

/* =========================
   Cloudflare Environment
   ========================= */

export interface Env {
  DB: D1Database;
}

/* =========================
   Database Row Types
   ========================= */

interface UserRow {
  id: string;
  credential_id: string;
  public_key: ArrayBuffer;
  counter: number;
  transports: string; // JSON string
}

interface EntryRow {
  id: number;
  user_id: string;
  title: string;
  email: string | null;
  date_val: string | null;
  slider_val: number | null;
  is_active: number | null;
  tags_json: string | null;
}

/* =========================
   Utilities
   ========================= */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function json<T>(value: T, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function badRequest(message: string): Response {
  return json({ error: message }, 400);
}

function getSessionUserId(req: Request): string | null {
  const cookie = req.headers.get('Cookie') ?? '';
  return cookie.match(/session=([^;]+)/)?.[1] ?? null;
}

function bufferFromBase64URL(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/* =========================
   HTML UI
   ========================= */

function renderUI(userId: string | null): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>D1 CRUD + WebAuthn</title>
  <style>
    body { font-family: system-ui; padding: 2rem; }
    footer {
      position: fixed;
      bottom: 2dvh;
      left: 50%;
      transform: translateX(-50%);
      font-size: 0.9rem;
      opacity: 0.7;
    }
  </style>
</head>
<body>
  <h1>D1 CRUD + WebAuthn</h1>
  <p>User: ${userId ?? 'anonymous'}</p>

  <footer>
    <a href="https://github.com/kusl/cloudflare-d1-crud" target="_blank">
      github.com/kusl/cloudflare-d1-crud
    </a>
  </footer>
</body>
</html>`;
}

/* =========================
   Worker
   ========================= */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const rpID = url.hostname;
    const origin = `https://${rpID}`;
    const userId = getSessionUserId(request);

    /* ---------- UI ---------- */

    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(renderUI(userId), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    /* ---------- Registration: Start ---------- */

    if (url.pathname === '/webauthn/register/start' && request.method === 'POST') {
      const newUserId = crypto.randomUUID();

      const options = await generateRegistrationOptions({
        rpName: 'Cloudflare D1 CRUD',
        rpID,
        userID: encoder.encode(newUserId),
        userName: newUserId,
        attestationType: 'none',
      });

      return json({ userId: newUserId, options });
    }

    /* ---------- Registration: Finish ---------- */

    if (url.pathname === '/webauthn/register/finish' && request.method === 'POST') {
      const body = (await request.json()) as {
        userId: string;
        response: RegistrationResponseJSON;
        expectedChallenge: string;
      };

      if (!body?.userId || !body?.response || !body?.expectedChallenge) {
        return badRequest('Invalid registration payload');
      }

      const verification = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: body.expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
      });

      if (!verification.verified || !verification.registrationInfo) {
        return badRequest('Registration failed');
      }

      const {
        credentialID,
        credentialPublicKey,
        counter,
        credentialDeviceType,
        credentialBackedUp,
      } = verification.registrationInfo;

      await env.DB.prepare(
        `INSERT INTO Users (id, credential_id, public_key, counter, transports)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(
        body.userId,
        Buffer.from(credentialID),
        credentialPublicKey,
        counter,
        JSON.stringify(body.response.response.transports ?? [])
      ).run();

      return json({ ok: true });
    }

    /* ---------- Authentication: Start ---------- */

    if (url.pathname === '/webauthn/auth/start' && request.method === 'POST') {
      if (!userId) return badRequest('No session');

      const user = await env.DB.prepare(
        `SELECT * FROM Users WHERE id = ?`
      ).bind(userId).first<UserRow>();

      if (!user) return badRequest('User not found');

      const options = await generateAuthenticationOptions({
        rpID,
        allowCredentials: [
          {
            id: new Uint8Array(user.public_key),
            type: 'public-key',
            transports: JSON.parse(user.transports),
          },
        ],
      });

      return json(options);
    }

    /* ---------- Authentication: Finish ---------- */

    if (url.pathname === '/webauthn/auth/finish' && request.method === 'POST') {
      const body = (await request.json()) as {
        response: AuthenticationResponseJSON;
        expectedChallenge: string;
      };

      if (!userId || !body?.response || !body?.expectedChallenge) {
        return badRequest('Invalid authentication payload');
      }

      const user = await env.DB.prepare(
        `SELECT * FROM Users WHERE id = ?`
      ).bind(userId).first<UserRow>();

      if (!user) return badRequest('User not found');

      const verification = await verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: body.expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        authenticator: {
          credentialID: bufferFromBase64URL(user.credential_id),
          credentialPublicKey: user.public_key,
          counter: user.counter,
          transports: JSON.parse(user.transports),
        },
      });

      if (!verification.verified) {
        return badRequest('Authentication failed');
      }

      await env.DB.prepare(
        `UPDATE Users SET counter = ? WHERE id = ?`
      ).bind(verification.authenticationInfo.newCounter, userId).run();

      return json({ ok: true });
    }

    return new Response('Not found', { status: 404 });
  },
};
