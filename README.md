# presence.tools - Terminal

The user-facing app that executes a presence event - it loads a session, walks a chain of identity challenges, and submits results. All business logic lives server-side.

## Hosted and ready to use

**This terminal is permanently hosted at `app.presence.tools`.** When you generate a session link via the presence.tools developer tools, it points here by default. No deployment, no infrastructure, no code required - it works out of the box.

This repository is open source so you can see exactly how it works, adapt it to your own brand, or replace it entirely with your own implementation. The API contract is the same either way.

---

## What's in here

| File | Purpose |
|------|---------|
| `index.html` | Full UI shell - all challenge screens, loading/error states, phone-frame layout |
| `app.js` | All runtime logic - session loading, challenge walker, API calls |
| `CONTEXT.md` | Full API and data model reference |
| `API_REFERENCE.md` | Request and response examples for every challenge type |
| `PROMPT.md` | AI prompt file - drop this into any AI coding session to get full context instantly |

---

## How it works

```
https://app.presence.tools/{sessionId}
```

1. The `sessionId` in the URL path is the only credential
2. The terminal fetches the session from the API
3. It walks `session.challenges[]` in order, rendering a UI for each type
4. Each challenge is submitted to a type-specific endpoint (`/sessions/{id}/pin`, `/face`, etc.)
5. The server returns `next`, `complete`, or `failed`
6. On `complete` or `failed` - show the result screen

---

## Challenge types

| Type | Description |
|------|-------------|
| `GEO` | Silent background location capture - merged into the next challenge's POST |
| `FACE` | Front camera selfie, captured as JPEG and submitted as base64 |
| `PIN` | Custom PIN pad - no OS keyboard, dots grow as you type |
| `SMS` | 4-digit code sent by SMS, 4-box input with autofill support |
| `EMAIL` | Same as SMS but delivered by email |
| `CALL` | Server calls the user - terminal shows a passphrase to read aloud, polls for completion |
| `PASSWORD` | Standard password input |
| `VIDEO` | 5-second recorded clip of the user saying a phrase, auto-submitted |
| `ENROL` | Dynamic form built from `challenge.fields[]` |

---

## No build step

Plain HTML and vanilla JS. Tailwind CSS via CDN. Copy the two files and host anywhere - S3, Cloudflare Pages, Vercel, a Raspberry Pi.

To test locally:

```bash
npx serve . --single
```

Then open `http://localhost:3000/{sessionId}`.

`localhost` automatically hits the dev API (`api.dev.presence.tools`). The prod API is used when hosted on `app.presence.tools`.

> **Note:** The session `GET` will work on localhost, but `POST` requests to the challenge endpoints will be blocked by CORS unless the API you're pointing at allows `localhost` as an origin. To test the full challenge flow locally, either configure CORS on your API to permit `localhost`, or deploy to a real domain and test there.

---

## Adapting this

This is a reference implementation - it's designed to be read and adapted, not used as-is. The comments in `app.js` and `index.html` explain every decision. Start with `CONTEXT.md` for the full API spec, or `PROMPT.md` to bring an AI assistant up to speed instantly.

---

## Privacy and legal obligations

This terminal captures **biometric data** (face images, video), **location data**, and **personal information**. If you deploy a modified version of this terminal, you inherit the legal responsibilities that come with that data collection.

### How presence.tools handles data

presence.tools is designed to operate blind to personal identity. Biometric verification is performed in real time and the result is a confidence score - we do not store a link between a biometric and a named individual inside our service. Personal identity data is provided by the operator and we do not retain it. We are a verification pipe, not a data store.

This architecture is intentional and reduces - but does not eliminate - the privacy obligations on operators using our platform.

### Your obligations if you modify and deploy this terminal

Depending on your jurisdiction and the people whose data you collect, this may include:

- **GDPR** (EU/UK) - lawful basis for processing, data minimisation, subject rights, breach notification
- **BIPA** (Illinois) - written consent before collecting biometric identifiers
- **CCPA / CPRA** (California) - disclosure and opt-out rights for biometric and location data
- Other national and regional biometric and privacy laws

At a minimum:

1. Display a clear privacy notice before or during data capture - use `session.privacyNoticeUrl` for this
2. Ensure you have a lawful basis for each type of data you collect
3. Have a data processing agreement in place with presence.tools if you are using their backend

**The MIT licence grants you freedom to use and modify this code. It does not grant freedom from privacy law.** If in doubt, take legal advice before deploying.

---

*presence.tools - open reference implementation - MIT licensed*
