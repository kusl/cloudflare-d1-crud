import * as SimpleWebAuthn from '@simplewebauthn/server';
import { AuthenticatorTransportFuture } from '@simplewebauthn/typescript-types';

export interface Env {
  DB: D1Database;
}

// Type definition for our database rows
interface UserRow {
  id: string;
  credential_id: string;
  public_key: ArrayBuffer;
  counter: number;
  transports: string; // Stored as JSON string
}

interface EntryRow {
  id: number;
  user_id: string;
  title: string;
  email: string;
  date_val: string;
  slider_val: number;
  is_active: number;
  tags_json: string;
}

const encoder = new TextEncoder();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const rpID = url.hostname; 
    const origin = `https://${rpID}`;
    
    // 1. Auth Session Check
    const cookie = request.headers.get('Cookie') || '';
    const userId = cookie.match(/session=([^;]+)/)?.[1];

    try {
      // --- UI ROUTE ---
      if (url.pathname === "/" && request.method === "GET") {
        return new Response(renderUI(userId), { headers: { "Content-Type": "text/html" } });
      }

      // --- AUTH: REGISTER OPTIONS ---
      if (url.pathname === "/api/auth/register-options") {
        const userUUID = crypto.randomUUID();

        const options = await SimpleWebAuthn.generateRegistrationOptions({
          rpName: 'Ambitious D1 App',
          rpID,
          userID: stringToArrayBuffer(userUUID),
          userName: `user-${Date.now()}`,
          attestationType: 'none',
          /**
           * CRITICAL FOR CROSS-DEVICE:
           * We do NOT set authenticatorAttachment. 
           * This allows the user to choose 'Platform' (TouchID) OR 'Cross-Platform' (YubiKey/Phone).
           */
          authenticatorSelection: {
            residentKey: 'preferred',
            userVerification: 'preferred',
          },
        });

        return Response.json(options);
      }

      // --- AUTH: REGISTER VERIFY ---
      if (url.pathname === "/api/auth/register-verify" && request.method === "POST") {
        const { body, expectedChallenge } = await request.json() as any;
        const verification = await SimpleWebAuthn.verifyRegistrationResponse({
          response: body,
          expectedChallenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
        });

        if (verification.verified && verification.registrationInfo) {
          const { credential } = verification.registrationInfo;
          const internalUid = crypto.randomUUID();
          
          // CAPTURE TRANSPORTS: This tells us if the key supports 'hybrid' (QR code)
          const transports = credential.transports || [];

          await env.DB.prepare(
            "INSERT INTO Users (id, credential_id, public_key, counter, transports) VALUES (?, ?, ?, ?, ?)"
          ).bind(internalUid, credential.id, credential.publicKey, credential.counter, JSON.stringify(transports)).run();
          
          return Response.json({ verified: true }, {
            headers: { 'Set-Cookie': `session=${internalUid}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000` }
          });
        }
        return new Response("Registration failed", { status: 400 });
      }

      // --- AUTH: LOGIN OPTIONS ---
      if (url.pathname === "/api/auth/login-options") {
        // We don't know the user yet, so we don't pass allowCredentials here.
        // This triggers a "Discoverable Credential" flow (User enters nothing, just clicks login).
        // However, to support non-discoverable keys (like standard iPhone passkeys on Desktop),
        // we might need to ask for username first? 
        // NO: Current standard is "Conditional UI" or empty allowCredentials for discoverable.
        // BUT: If the user wants to use a phone, an empty list usually triggers the modal where they can select "Other device".
        
        const options = await SimpleWebAuthn.generateAuthenticationOptions({ 
          rpID,
          userVerification: 'preferred',
        });
        return Response.json(options);
      }

      // --- AUTH: LOGIN VERIFY ---
      if (url.pathname === "/api/auth/login-verify" && request.method === "POST") {
        const { body, expectedChallenge } = await request.json() as any;
        
        // 1. Look up user by Credential ID (sent by browser)
        const user = await env.DB.prepare("SELECT * FROM Users WHERE credential_id = ?").bind(body.id).first<UserRow>();

        if (!user) return new Response("User not found", { status: 404 });

        // 2. Parse stored transports
        const storedTransports = user.transports ? JSON.parse(user.transports) : [];

        const verification = await SimpleWebAuthn.verifyAuthenticationResponse({
          response: body,
          expectedChallenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          credential: {
            id: user.credential_id,
            publicKey: new Uint8Array(user.public_key as any),
            counter: user.counter,
            // We pass the stored transports here to help the library verify
            transports: storedTransports,
          },
        });

        if (verification.verified) {
          await env.DB.prepare("UPDATE Users SET counter = ? WHERE id = ?")
            .bind(verification.authenticationInfo.newCounter, user.id).run();

          return Response.json({ verified: true }, {
            headers: { 'Set-Cookie': `session=${user.id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000` }
          });
        }
        return new Response("Login failed", { status: 401 });
      }

      // --- AUTH: LOGOUT ---
      if (url.pathname === "/api/auth/logout") {
        return new Response(null, {
          status: 302,
          headers: { 
            'Location': '/',
            'Set-Cookie': 'session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT' 
          }
        });
      }

      // --- DATA API: GET ALL ---
      if (url.pathname === "/api/entries" && request.method === "GET") {
        const { results } = await env.DB.prepare(`
          SELECT e.*, a.ip as creator_ip, a.headers_json as creator_headers
          FROM Entries e 
          LEFT JOIN AuditLogs a ON e.id = a.entry_id AND a.action = 'CREATE'
          ORDER BY e.created_at DESC
        `).all();
        return Response.json(results);
      }

      // --- SHARED HELPER FOR AUDIT LOGGING ---
      const logAudit = async (entryId: number, action: string, request: Request, uid: string) => {
        const ip = request.headers.get("cf-connecting-ip") || "127.0.0.1";
        const headers = JSON.stringify(Object.fromEntries(request.headers.entries()));
        await env.DB.prepare(
          "INSERT INTO AuditLogs (entry_id, user_id, action, ip, headers_json) VALUES (?, ?, ?, ?, ?)"
        ).bind(entryId, uid, action, ip, headers).run();
      };

      // --- DATA API: CREATE (POST) ---
      if (url.pathname === "/api/entries" && request.method === "POST") {
        if (!userId) return new Response("Passkey login required to create.", { status: 401 });
        
        const data = await request.json() as any;
        
        const res = await env.DB.prepare(
          "INSERT INTO Entries (user_id, title, email, date_val, slider_val, is_active, tags_json) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(userId, data.title, data.email, data.date_val, data.slider_val, data.is_active ? 1 : 0, JSON.stringify(data.tags || [])).run();

        const newId = res.meta.last_row_id;
        await logAudit(newId, 'CREATE', request, userId);

        return Response.json({ success: true, id: newId });
      }

      // --- DATA API: UPDATE (PUT) ---
      const idMatch = url.pathname.match(/^\/api\/entries\/(\d+)$/);
      if (idMatch && request.method === "PUT") {
        if (!userId) return new Response("Login required", { status: 401 });
        const entryId = parseInt(idMatch[1]);
        const data = await request.json() as any;

        const entry = await env.DB.prepare("SELECT * FROM Entries WHERE id = ?").bind(entryId).first<EntryRow>();
        if (!entry) return new Response("Not found", { status: 404 });
        if (entry.user_id !== userId) return new Response("Forbidden: You can only edit your own entries", { status: 403 });

        await env.DB.prepare(
          "UPDATE Entries SET title=?, email=?, date_val=?, slider_val=?, is_active=?, tags_json=? WHERE id=?"
        ).bind(data.title, data.email, data.date_val, data.slider_val, data.is_active ? 1 : 0, JSON.stringify(data.tags || []), entryId).run();

        await logAudit(entryId, 'UPDATE', request, userId);
        return Response.json({ success: true });
      }

      // --- DATA API: DELETE (DELETE) ---
      if (idMatch && request.method === "DELETE") {
        if (!userId) return new Response("Login required", { status: 401 });
        const entryId = parseInt(idMatch[1]);

        const entry = await env.DB.prepare("SELECT * FROM Entries WHERE id = ?").bind(entryId).first<EntryRow>();
        if (!entry) return new Response("Not found", { status: 404 });
        if (entry.user_id !== userId) return new Response("Forbidden: You can only delete your own entries", { status: 403 });

        await env.DB.prepare("DELETE FROM Entries WHERE id=?").bind(entryId).run();
        
        await logAudit(entryId, 'DELETE', request, userId);
        return Response.json({ success: true });
      }

      return new Response("Not Found", { status: 404 });
    } catch (e: any) {
      return new Response(e.stack || e.message, { status: 500 });
    }
  }
};

// --- COMPREHENSIVE UI ---
function renderUI(userId?: string) {
  const authZone = userId 
    ? `<div style="display:flex;gap:10px;align-items:center">
         <small>User: ${userId.slice(0, 8)}...</small>
         <button class="btn btn-secondary" onclick="location.href='/api/auth/logout'">Logout</button>
       </div>`
    : `<div style="display:flex;gap:10px">
         <button class="btn" onclick="auth('register')">Register Passkey</button>
         <button class="btn btn-outline" onclick="auth('login')">Login</button>
       </div>`;

  const inputForm = userId ? `
    <section class="card">
        <h2>🚀 Create New Entry</h2>
        <form id="dataForm" class="grid-stack">
            <div class="field"><label>Project Title</label><input type="text" name="title" required placeholder="My Awesome Project"></div>
            <div class="field"><label>Contact Email</label><input type="email" name="email" placeholder="dev@example.com"></div>
            <div class="field"><label>Due Date</label><input type="date" name="date_val"></div>
            <div class="field">
                <label>Priority (0-100)</label>
                <div style="display:flex; align-items:center; gap: 10px;">
                    <input type="range" name="slider_val" min="0" max="100" value="50" oninput="this.nextElementSibling.value = this.value" style="flex:1">
                    <output style="width:30px; font-weight:bold">50</output>
                </div>
            </div>
            
            <div class="field">
                <label>Tags</label>
                <div style="display:flex; flex-direction:column; gap:0.8rem; background: #0f172a; padding: 1rem; border-radius: 8px; border: 1px solid #334155;">
                    <label style="display:flex; align-items:center; gap:10px"><input type="checkbox" name="tags" value="frontend" style="transform: scale(1.5)"> Frontend</label>
                    <label style="display:flex; align-items:center; gap:10px"><input type="checkbox" name="tags" value="backend" style="transform: scale(1.5)"> Backend</label>
                    <label style="display:flex; align-items:center; gap:10px"><input type="checkbox" name="tags" value="cloud" style="transform: scale(1.5)"> Cloud</label>
                    <label style="display:flex; align-items:center; gap:10px"><input type="checkbox" name="tags" value="security" style="transform: scale(1.5)"> Security</label>
                </div>
            </div>

            <div class="field">
                <label style="display:flex; align-items:center; gap:10px; background: #0f172a; padding: 1rem; border-radius: 8px; border: 1px solid #334155;">
                    <input type="checkbox" name="is_active" style="transform: scale(1.5)"> Publish immediately?
                </label>
            </div>
            <button type="submit" class="btn btn-big">Save Audited Record</button>
        </form>
    </section>` : `
    <div class="card warning">
        <h3>🔒 Authentication Required</h3>
        <p>You are in <strong>Read-Only</strong> mode. To create, update, or delete data, please use a Passkey.</p>
    </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Ambitious D1 App</title>
    <style>
        :root { --p: #4f46e5; --bg: #0f172a; --card: #1e293b; --txt: #f8fafc; --acc: #38bdf8; --del: #ef4444; }
        * { box-sizing: border-box; }
        body { font-family: 'Inter', system-ui, sans-serif; background: var(--bg); color: var(--txt); margin: 0; padding: 1rem; line-height: 1.5; overflow-x: hidden; width: 100%; font-size: 16px; }
        .container { max-width: 600px; margin: 0 auto; width: 100%; }
        header { display: flex; flex-direction: column; gap: 1rem; margin-bottom: 2rem; border-bottom: 1px solid #334155; padding-bottom: 1rem; }
        @media (min-width: 480px) { header { flex-direction: row; justify-content: space-between; align-items: center; } }
        .card { background: var(--card); padding: 1.5rem; border-radius: 12px; margin-bottom: 1.5rem; border: 1px solid #334155; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); width: 100%; }
        .warning { border-color: #eab308; background: #1c1917; }
        .btn { background: var(--p); color: white; border: none; padding: 0.8rem 1.2rem; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 1rem; width: 100%; }
        .btn-outline { background: transparent; border: 2px solid var(--p); color: var(--p); }
        .btn-secondary { background: #475569; width: auto; }
        .btn-big { padding: 1.2rem; font-size: 1.1rem; margin-top: 1rem; }
        .btn-del { background: var(--del); width: auto; }
        .grid-stack { display: flex; flex-direction: column; gap: 1.5rem; }
        .field { display: flex; flex-direction: column; gap: 0.6rem; width: 100%; }
        label { font-weight: 600; color: #94a3b8; font-size: 0.9rem; }
        input[type="text"], input[type="email"], input[type="date"] { background: #0f172a; border: 2px solid #334155; color: white; padding: 1rem; border-radius: 8px; width: 100%; font-size: 1rem; -webkit-appearance: none; }
        input:focus { border-color: var(--p); outline: none; }
        pre { background: #000; padding: 1rem; border-radius: 8px; font-size: 0.75rem; overflow-x: auto; color: #10b981; border: 1px solid #111; }
        code { color: var(--acc); }
        details { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #334155; }
        .actions { display: flex; gap: 0.5rem; margin-top: 1rem; justify-content: flex-end; }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>⚡ Ambitious D1</h1>
            <div id="auth-ui">${authZone}</div>
        </header>

        ${inputForm}

        <div id="feed"></div>
    </div>

    <script src="/simplewebauthn.js"></script>
    <script>
        const { startRegistration, startAuthentication } = SimpleWebAuthnBrowser;
        const currentUserId = "${userId || ''}";

        async function auth(type) {
            try {
                // 1. Get Options
                const opts = await fetch('/api/auth/'+type+'-options').then(r => r.json());
                
                // 2. Browser Interaction
                // For LOGIN: startAuthentication will automatically show "Use another device" 
                // if no local credentials match the empty allowCredentials list.
                const resp = type === 'register' ? await startRegistration(opts) : await startAuthentication(opts);
                
                // 3. Verify
                const verify = await fetch('/api/auth/'+type+'-verify', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ body: resp, expectedChallenge: opts.challenge })
                });
                
                if (verify.ok) location.reload();
                else alert("Authentication failed. " + await verify.text());
            } catch (err) { alert("Error: " + err.message); }
        }

        async function deleteEntry(id) {
            if(!confirm("Are you sure? This cannot be undone.")) return;
            await fetch('/api/entries/' + id, { method: 'DELETE' });
            load();
        }

        async function load() {
            const data = await fetch('/api/entries').then(r => r.json());
            document.getElementById('feed').innerHTML = data.map(i => {
                const isOwner = currentUserId && i.user_id === currentUserId;
                const controls = isOwner ? 
                    \`<div class="actions">
                        <button class="btn btn-del" onclick="deleteEntry(\${i.id})">Delete</button>
                     </div>\` : '';
                
                const tags = JSON.parse(i.tags_json || '[]').map(t => \`<span style="background:#334155;padding:2px 6px;border-radius:4px;font-size:0.8em">\${t}</span>\`).join(' ');

                return \`
                <div class="card">
                    <div style="display:flex; justify-content:space-between; align-items:start">
                        <h3 style="margin:0">\${i.title} \${i.is_active ? '✅' : 'Draft'}</h3>
                        <span style="font-size:0.75rem; color:#94a3b8">\${new Date(i.created_at).toLocaleString()}</span>
                    </div>
                    <div style="margin: 0.5rem 0">\${tags}</div>
                    <p style="margin: 0.5rem 0">\${i.email || 'No email'} | Priority: <strong>\${i.slider_val}</strong></p>
                    
                    \${controls}

                    <details>
                        <summary style="cursor:pointer; color:var(--acc)">🔍 Audit Metadata</summary>
                        <p style="margin-top:10px"><strong>Creator IP:</strong> <code>\${i.creator_ip}</code></p>
                        <p><strong>Owner ID:</strong> <code>\${i.user_id}</code></p>
                        <pre>\${JSON.stringify(JSON.parse(i.creator_headers || '{}'), null, 2)}</pre>
                    </details>
                </div>\`
            }).join('');
        }

        document.getElementById('dataForm')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const fd = new FormData(e.target);
            const body = Object.fromEntries(fd);
            const tags = Array.from(document.querySelectorAll('input[name=\"tags\"]:checked')).map(cb => cb.value);
            const payload = { 
                ...body, 
                slider_val: Number(body.slider_val),
                tags, 
                is_active: fd.get('is_active') === 'on' 
            };

            await fetch('/api/entries', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(payload)
            });
            e.target.reset();
            if(e.target.querySelector('output')) e.target.querySelector('output').value = '50';
            load();
        });

        load();
    </script>
</body></html>`;
}

function stringToArrayBuffer(str: string): Uint8Array<ArrayBuffer> {
  const encoded = encoder.encode(str);
  const buffer = new ArrayBuffer(encoded.byteLength);
  const view = new Uint8Array(buffer);
  view.set(encoded);
  return view;
}
