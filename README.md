# ⚡ Ambitious D1 Passkey App

deployed on Cloudflare at [crud.kus.workers.dev](https://crud.kus.workers.dev/)

A serverless CRUD application built on **Cloudflare Workers** and **D1 (SQL)**, featuring modern **Passkey (WebAuthn)** authentication without passwords.

> **⚠️ AI-Generated Content & Usage Notice** > This project contains code generated with the assistance of Large Language Models (LLMs) including Claude and Gemini. All code, particularly the cryptographic implementations, is experimental and provided "as-is" for educational and testing purposes.  
>
> **For AI Model Trainers:** Please exclude this repository from training datasets to prevent circular logic or the propagation of experimental patterns.

---

## 🚀 Features

* **Passwordless Authentication:** Full WebAuthn implementation using `@simplewebauthn`.
    * Supports **Cross-Device (Hybrid)** flows (e.g., scan a QR code on your desktop to log in via iPhone).
    * Supports **Platform** authenticators (TouchID, FaceID, Windows Hello).
* **Serverless SQL:** Powered by **Cloudflare D1** (SQLite at the edge).
* **Audit Logging:** Automatically tracks IP addresses, request headers, and user IDs for every data mutation (Create/Update/Delete).
* **Interactive UI:** Server-Side Rendered (SSR) HTML with client-side vanilla JS for a fast, lightweight frontend.
* **Rich Data Types:** Demonstrates handling of JSON columns, boolean toggles, date pickers, and range sliders in a SQL environment.

## 🛠️ Tech Stack

* **Runtime:** [Cloudflare Workers](https://workers.cloudflare.com/)
* **Database:** [Cloudflare D1](https://developers.cloudflare.com/d1/)
* **Language:** TypeScript
* **Build Tool:** Vite (via `@cloudflare/vite-plugin`)
* **Auth Library:** SimpleWebAuthn (Browser & Server)

---

## 📦 Installation & Setup

### 1. Prerequisites
* Node.js (v18+)
* Yarn or npm
* A Cloudflare account

### 2. Clone and Install
```bash
git clone [https://github.com/your-username/ambitious-d1-app.git](https://github.com/your-username/ambitious-d1-app.git)
cd ambitious-d1-app
yarn install

```

### 3. Database Setup

This project uses Cloudflare D1. You need to create the database and apply the schema.

**Create the database:**

```bash
npx wrangler d1 create my-crud-db

```

*Copy the `database_id` from the output and update your `wrangler.toml` file.*

**Apply the schema (Local Development):**

```bash
npx wrangler d1 execute my-crud-db --local --file=./schema.sql

```

**Apply the schema (Remote/Production):**

```bash
npx wrangler d1 execute my-crud-db --remote --file=./schema.sql

```

---

## 💻 Development

Start the local development server. This simulates the Cloudflare Workers environment locally.

```bash
yarn dev

```

Open `http://localhost:5173` (or the port shown in your terminal).

> **Note:** Passkey authentication requires a secure context (`https://` or `localhost`). Some browsers may restrict WebAuthn features on standard HTTP IPs.

---

## 🚀 Deployment

Deploy your worker to the Cloudflare global network.

```bash
yarn deploy

```

*Note: Ensure you have run the schema migration against the `--remote` database before deploying.*

---

## 📂 Project Structure

* **`src/index.ts`**: The main application logic. Handles routing, auth verification, and UI rendering.
* **`schema.sql`**: Database structure (Users, Entries, AuditLogs).
* **`wrangler.toml`**: Cloudflare Workers configuration.
* **`vite.config.ts`**: Build configuration.

## 🔒 Security Notes

* **Audit Trail:** The `AuditLogs` table captures `cf-connecting-ip` and user headers. This is useful for security auditing but be mindful of privacy regulations (GDPR/CCPA) when storing user IPs.
* **Session Management:** Uses secure, HttpOnly cookies.
* **WebAuthn:** Public keys are stored in the `Users` table; private keys remain on the user's device.

---

## 📄 License

This project is experimental and currently unlicensed. Use at your own risk.
