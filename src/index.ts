import * as SimpleWebAuthn from '@simplewebauthn/server';

export interface Env {
  DB: D1Database;
}

/* ----------------------------- DB Row Types ----------------------------- */

interface UserRow {
  id: string;
  credential_id: string;
  public_key: ArrayBuffer | Uint8Array;
  counter: number;
  transports: string | null;
}

interface EntryRow {
  id: number;
  user_id: string;
  title: string;
  email: string | null;
  date_val: string | null;
  slider_val: number | null;
  is_active: number;
  tags_json: string | null;
  created_at: string;
}

/* ----------------------------- Utilities ----------------------------- */

const encoder = new TextEncoder();

function parseSessionCookie(request: Request): string | null {
  const cookie = request.headers.get('Cookie') ?? '';
  const match = cookie.match(/(?:^|;\s*)session=([^;]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function setSessionCookie(userId: string): string {
  return `session=${encodeURIComponent(
    userId,
  )}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

function clearSessionCookie(): string {
  return `session=; Path=/; HttpOnly; Secure; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

function stringToArrayBuffer(str: string): Uint8Array {
  return encoder.encode(str);
}

function safeJSONParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/* ----------------------------- Worker ----------------------------- */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const rpID = url.hostname;
    const origin =
      request.headers.get('Origin') ?? `https://${rpID}`;

    const userId = parseSessionCookie(request);

    /* ----------------------------- UI ----------------------------- */

    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(renderHTML(Boolean(userId)), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    /* ----------------------- Registration Options ----------------------- */

    if (url.pathname === '/register/options' && request.method === 'POST') {
      const userUUID = crypto.randomUUID();

      const options =
        await SimpleWebAuthn.generateRegistrationOptions({
          rpName: 'Cloudflare D1 CRUD',
          rpID,
          userID: stringToArrayBuffer(userUUID),
          userName: userUUID,
          authenticatorSelection: {
            residentKey: 'preferred',
            userVerification: 'preferred',
          },
          attestationType: 'none',
        });

      return new Response(
        JSON.stringify({ options, userId: userUUID }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }

    /* ----------------------- Registration Verify ----------------------- */

    if (url.pathname === '/register/verify' && request.method === 'POST') {
      const { attestation, userId: providedUserId } =
        (await request.json()) as {
          attestation: any;
          userId: string;
        };

      const verification =
        await SimpleWebAuthn.verifyRegistrationResponse({
          response: attestation,
          expectedChallenge: undefined,
          expectedOrigin: origin,
          expectedRPID: rpID,
        });

      if (!verification.verified || !verification.registrationInfo) {
        return new Response('Registration failed', { status: 400 });
      }

      const { credential } = verification.registrationInfo;

      const transports = credential.transports ?? [];

      await env.DB.prepare(
        `INSERT INTO Users (id, credential_id, public_key, counter, transports)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(
          providedUserId,
          credential.id,
          credential.publicKey,
          credential.counter,
          JSON.stringify(transports),
        )
        .run();

      return new Response(JSON.stringify({ success: true }), {
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': setSessionCookie(providedUserId),
        },
      });
    }

    /* ----------------------- Login Options ----------------------- */

    if (url.pathname === '/login/options' && request.method === 'POST') {
      const options =
        await SimpleWebAuthn.generateAuthenticationOptions({
          rpID,
          userVerification: 'preferred',
        });

      return new Response(JSON.stringify(options), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    /* ----------------------- Login Verify ----------------------- */

    if (url.pathname === '/login/verify' && request.method === 'POST') {
      const assertion = await request.json();

      const credentialID =
        assertion?.id ?? assertion?.rawId;
      if (!credentialID) {
        return new Response('Missing credential ID', {
          status: 400,
        });
      }

      const user = await env.DB.prepare(
        'SELECT * FROM Users WHERE credential_id = ?',
      )
        .bind(credentialID)
        .first<UserRow>();

      if (!user) {
        return new Response('User not found', { status: 404 });
      }

      const storedTransports = safeJSONParse<string[]>(
        user.transports,
        [],
      );

      const verification =
        await SimpleWebAuthn.verifyAuthenticationResponse({
          response: assertion,
          expectedChallenge: undefined,
          expectedOrigin: origin,
          expectedRPID: rpID,
          authenticator: {
            credentialID: stringToArrayBuffer(user.credential_id),
            credentialPublicKey: new Uint8Array(
              user.public_key as ArrayBuffer,
            ),
            counter: user.counter,
            transports: storedTransports,
          },
        });

      if (!verification.verified) {
        return new Response('Authentication failed', {
          status: 401,
        });
      }

      await env.DB.prepare(
        'UPDATE Users SET counter = ? WHERE id = ?',
      )
        .bind(
          verification.authenticationInfo.newCounter,
          user.id,
        )
        .run();

      return new Response(JSON.stringify({ success: true }), {
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': setSessionCookie(user.id),
        },
      });
    }

    /* ----------------------------- Logout ----------------------------- */

    if (url.pathname === '/logout' && request.method === 'POST') {
      return new Response(JSON.stringify({ success: true }), {
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': clearSessionCookie(),
        },
      });
    }

    /* ----------------------------- CRUD APIs ----------------------------- */

    if (!userId) {
      return new Response('Unauthorized', { status: 401 });
    }

    if (url.pathname === '/api/entries' && request.method === 'GET') {
      const rows = await env.DB.prepare(
        'SELECT * FROM Entries WHERE user_id = ? ORDER BY created_at DESC',
      )
        .bind(userId)
        .all<EntryRow>();

      return Response.json(rows.results);
    }

    if (url.pathname === '/api/entries' && request.method === 'POST') {
      const body = await request.json();

      const result = await env.DB.prepare(
        `INSERT INTO Entries
         (user_id, title, email, date_val, slider_val, is_active, tags_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          userId,
          body.title,
          body.email ?? null,
          body.date_val ?? null,
          body.slider_val ?? null,
          body.is_active ? 1 : 0,
          JSON.stringify(body.tags ?? []),
        )
        .run();

      await env.DB.prepare(
        `INSERT INTO AuditLogs
         (entry_id, user_id, action, ip, headers_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(
          result.meta.last_row_id,
          userId,
          'create',
          request.headers.get('CF-Connecting-IP'),
          JSON.stringify([...request.headers]),
        )
        .run();

      return Response.json({ success: true });
    }

    return new Response('Not Found', { status: 404 });
  },
};

/* ----------------------------- HTML ----------------------------- */

function renderHTML(isLoggedIn: boolean): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Cloudflare D1 CRUD + Passkeys</title>
  <script src="/simplewebauthn.js"></script>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; }
    footer {
      margin-top: 8dvh;
      font-size: 0.9rem;
      opacity: 0.7;
    }
  </style>
</head>
<body>
  <h1>Cloudflare D1 CRUD + Passkeys</h1>

  ${
    isLoggedIn
      ? `<p>You are logged in.</p>
         <button onclick="logout()">Logout</button>`
      : `<button onclick="register()">Register</button>
         <button onclick="login()">Login</button>`
  }

  <footer>
    <a href="https://github.com/kusl/cloudflare-d1-crud" target="_blank">
      View on GitHub
    </a>
  </footer>

  <script>
    const { startRegistration, startAuthentication } = SimpleWebAuthnBrowser;

    async function register() {
      const r1 = await fetch('/register/options', { method: 'POST' });
      const { options, userId } = await r1.json();
      const attestation = await startRegistration(options);
      await fetch('/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attestation, userId })
      });
      location.reload();
    }

    async function login() {
      const r1 = await fetch('/login/options', { method: 'POST' });
      const options = await r1.json();
      const assertion = await startAuthentication(options);
      await fetch('/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(assertion)
      });
      location.reload();
    }

    async function logout() {
      await fetch('/logout', { method: 'POST' });
      location.reload();
    }
  </script>
</body>
</html>`;
}

