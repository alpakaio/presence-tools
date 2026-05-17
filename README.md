# presence.tools — Terminal

The user-facing app that executes a presence event — it loads a session, walks a chain of identity challenges, and submits results. All business logic lives server-side.

## You may not need this

**This terminal is permanently hosted at `app.presence.tools` and is available to all presence.tools customers immediately.** Session links work out of the box — no deployment, no infrastructure, no code required.

This repository is for developers who want to **customise or replace** the terminal: match their own brand, embed it in an existing product, or extend it with additional behaviour. If that's not you, just use `https://app.presence.tools/{sessionId}` and you're done.

---

## What's in here

| File | Purpose |
|------|---------|
| `index.html` | Full UI shell — all challenge screens, loading/error states, phone-frame layout |
| `app.js` | All runtime logic — session loading, challenge walker, API calls |
| `CONTEXT.md` | Full API and data model reference |
| `PROMPT.md` | AI prompt file — drop this into any AI coding session to get full context instantly |

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
6. On `complete` or `failed` — show the result screen

---

## Challenge types

| Type | Description |
|------|-------------|
| `GEO` | Silent background location capture — merged into the next challenge's POST |
| `FACE` | Front camera selfie, captured as JPEG and submitted as base64 |
| `PIN` | Custom PIN pad — no OS keyboard, dots grow as you type |
| `SMS` / `SMS` | 4-digit code sent by SMS, 4-box input with autofill support |
| `EMAIL` / `EMAIL` | Same as SMS but delivered by email |
| `CALL` | Server calls the user — terminal shows a passphrase to read aloud, polls for completion |
| `PASSWORD` | Standard password input |
| `VIDEO` | 5-second recorded clip of the user saying a phrase, auto-submitted |
| `ENROL` | Dynamic form built from `challenge.fields[]` |

---

## No build step

Plain HTML and vanilla JS. Tailwind CSS via CDN. Copy the two files and host anywhere — S3, Cloudflare Pages, Vercel, a Raspberry Pi.

To test locally:

```bash
npx serve . --single
```

Then open `http://localhost:3000/{sessionId}`.

`localhost` automatically hits the dev API (`api.dev.presence.tools`). The prod API is used when hosted on `app.presence.tools`.

---

## Adapting this

This is a reference implementation — it's designed to be read and adapted, not used as-is. The comments in `app.js` and `index.html` explain every decision. Start with `CONTEXT.md` for the full API spec, or `PROMPT.md` to bring an AI assistant up to speed instantly.

---

*presence.tools — open reference implementation*
