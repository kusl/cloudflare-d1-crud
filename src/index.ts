import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';

export interface Env {
  DB: D1Database;
}

/* ================= Utilities ================= */

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function badRequest(msg: string): Response {
  return json({ error: msg }, 400);
}

function base64urlToArrayBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const buf = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) {
    view[i] = binary.charCodeAt(i);
  }
  return buf;
}

function stringToUint8ArrayStrict(value: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(value);
  const buf = new ArrayBuffer(encoded.length);
  const view = new Uint8Array(buf);
  view.set(encoded);
  return view;
}

/* ================= HTML ================= */

function renderHTML(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Cloudflare D1 CRUD</title>
  <style>
    body { font-family: system-ui; padding: 2rem; }
    footer {
      position: fixed;
      bottom: 2dvh;
      left: 50%;
      transform: translateX(-50%);
      font-size: 0.85rem;
      opacity: 0.7;
    }
  </style>
</head>
<body>
  <h1>Cloudflare D1 CRUD</h1>
  <footer>
    <a href="https://github.com/kusl/cloudflare-d1-crud" target="_blank">
      github.com/kusl/cloudflare-d1-crud
    </a>
  </footer>
</body>
</html>`;
}

/* ================= Worker ================= */

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const rpID = url.hostname;
    const origin = `https://${rpID}`;

    if (req.method === 'GET' && url.pathname === '/') {
      return new Response(renderHTML(), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    /* -------- Registration start -------- */

    if (req.method === 'POST' && url.pathname === '/register/start') {
      const userId = crypto.randomUUID();

      const options = await generateRegistrationOptions({
        rpName: 'Cloudflare D1 CRUD',
        rpID,
        userID: stringToUint8ArrayStrict(userId),
        userName: userId,
        attestationType: 'none',
      });

      return json({ userId, options });
    }

    /* -------- Registration finish -------- */

    if (req.method === 'POST' && url.pathname === '/register/finish') {
      const body = (await req.json()) as {
        userId: string;
        expectedChallenge: string;
        response: RegistrationResponseJSON;
      };

      if (!body?.userId || !body?.expectedChallenge || !body?.response) {
        return badRequest('Invalid payload');
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

      const { credential } = verification.registrationInfo;

      await env.DB.prepare(
        `INSERT INTO Users (id, credential_id, public_key, counter, transports)
         VALUES (?, ?, ?, ?, ?)`
      )
        .bind(
          body.userId,
          credential.id,
          credential.publicKey,
          credential.counter,
          JSON.stringify(body.response.response.transports ?? []),
        )
        .run();

      return json({ ok: true });
    }

    /* -------- Authentication start -------- */

    if (req.method === 'POST' && url.pathname === '/auth/start') {
      const body = (await req.json()) as { userId: string };
      if (!body?.userId) return badRequest('Missing userId');

      const user = await env.DB.prepare(
        `SELECT * FROM Users WHERE id = ?`
      )
        .bind(body.userId)
        .first<{
          credential_id: string;
          transports: string;
        }>();

      if (!user) return badRequest('User not found');

      const options = await generateAuthenticationOptions({
        rpID,
        allowCredentials: [
          {
            id: user.credential_id,
            transports: JSON.parse(user.transports),
          },
        ],
      });

      return json(options);
    }

    /* -------- Authentication finish -------- */

    if (req.method === 'POST' && url.pathname === '/auth/finish') {
      const body = (await req.json()) as {
        userId: string;
        expectedChallenge: string;
        response: AuthenticationResponseJSON;
      };

      if (!body?.userId || !body?.expectedChallenge || !body?.response) {
        return badRequest('Invalid payload');
      }

      const user = await env.DB.prepare(
        `SELECT * FROM Users WHERE id = ?`
      )
        .bind(body.userId)
        .first<{
          credential_id: string;
          public_key: ArrayBuffer;
          counter: number;
          transports: string;
        }>();

      if (!user) return badRequest('User not found');

      const verification = await verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: body.expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: user.credential_id,
          publicKey: new Uint8Array(user.public_key),
          counter: user.counter,
          transports: JSON.parse(user.transports),
        },
      });

      if (!verification.verified) {
        return badRequest('Authentication failed');
      }

      await env.DB.prepare(
        `UPDATE Users SET counter = ? WHERE id = ?`
      )
        .bind(verification.authenticationInfo.newCounter, body.userId)
        .run();

      return json({ ok: true });
    }

    return new Response('Not found', { status: 404 });
  },
};

