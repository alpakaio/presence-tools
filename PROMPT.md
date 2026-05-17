# AI Context — presence.tools Terminal

Drop this file into your AI coding session alongside `CONTEXT.md`, `index.html`, and `app.js` to give your assistant full context on the project.

---

## What this project is

A single-page web app that executes a **presence event** for a given identity. It is intentionally dumb — it loads a session, walks a chain of identity challenges, and submits results. All business logic, validation, and webhook firing happens server-side. The terminal captures, renders, and submits. Nothing more.

It is a **public reference implementation** — heavily commented, no build step, designed to be read and adapted by developers building on the presence.tools platform.

---

## Stack

- **Plain HTML + vanilla JS.** No framework, no bundler, no build step.
- **Tailwind CSS via CDN** for styling.
- **Two files:** `index.html` (layout and UI states) and `app.js` (all runtime logic).
- **Phone-only UX.** Max 430px width. On desktop, the app is centred with a phone-frame shadow.
- Hosted as a static site on S3 + CloudFront at `app.presence.tools` (prod) and `app.dev.presence.tools` (dev).

---

## API

**Base URL** is auto-detected from the hostname:
- `file://` or `localhost` → `https://api.dev.presence.tools`
- hostname contains `.dev.` → `https://api.dev.presence.tools`
- otherwise → `https://api.presence.tools`

### Load session
```
GET /sessions/{sessionId}
```
Returns the full session object. The server marks `used: true` on first load — the terminal does not need to do this explicitly.

### Submit a challenge
```
POST /sessions/{sessionId}/{type}
```
Where `{type}` is the lowercase challenge type: `pin`, `face`, `sms`, `email`, `password`, `video`, `enrol`, `call`.

**Body** is a JSON array containing only the relevant challenges — never the full chain:
```json
[
  { "type": "GEO", "lat": 51.5074, "lng": -0.1278 },
  { "type": "PIN", "value": "1234", "identityId": "id_abc" }
]
```
GEO is included first if it was captured earlier in the chain. `identityId` is included once the server has resolved it (from a previous challenge response).

**Server response:**
```json
{ "status": "next" }
{ "status": "complete", "success": true, "confidence": 0.98 }
{ "status": "failed", "reason": "PIN_INCORRECT" }
```
If the response includes `identityId`, it is written to the local session object and included in all subsequent challenge POSTs.

---

## Session object
```javascript
{
  sessionId,
  eventId,
  projectId,
  accountId,
  identityId,        // absent for open/enrol sessions; set once resolved
  configId,
  name,
  challenges: [
    { type: 'GEO', maxDistance: 50 },
    { type: 'FACE' },
    { type: 'PIN' },
    { type: 'SMS', value: '...' },      // value present on some types
  ],
  locations: [
    { locationId, window: { opens_at, closes_at } }
  ],
  displayName: 'Acme Corp',
  privacyNoticeUrl: 'https://...',
  used: false,
}
```

---

## Challenge chain logic

`session.challenges[]` is walked in order using `_challengeIndex`. Each challenge is handled by a type-specific handler in `_challengeHandlers`. After a successful POST, `_handleResponse()` routes on `status`:

- `next` → increment `_challengeIndex`, call `_runChallenge()`
- `complete` → show complete screen
- `failed` → show failed screen with human-readable reason copy

---

## Challenge types — behaviour

### GEO
Silent. Never renders UI. Never POSTs alone. Captures coordinates via the browser Geolocation API (`enableHighAccuracy: true`), stores in `_pendingGeo`, advances immediately to the next challenge. `_respond()` merges the coords into the next challenge's POST body automatically.

### FACE
Opens front camera (`facingMode: "user"`). Displays a dashed oval guide overlay. User taps "Take photo" — a JPEG frame is captured via `<canvas>`, converted to base64 (`toDataURL('image/jpeg', 0.85)`), and POSTed as `imageData`. Camera stream is stopped before the network call.

### PIN
Custom PIN pad — no OS keyboard. Dot display grows as digits are entered (always one empty dot ahead, so length is never revealed). Submits `value` as a string. Min 1 digit, max 8.

### SMS / SMS / EMAIL / EMAIL
4-box digit input. Each box accepts one digit. Typing auto-advances focus. Backspace moves focus back. Paste splits a full code across all boxes (handles iOS SMS autofill). `autocomplete="one-time-code"` on the first box triggers OS autofill. Submits `value` as a 4-digit string. `SMS` and `EMAIL` are aliases for `SMS` and `EMAIL`.

### CALL
Server initiates a voice call. `challenge.value` contains a passphrase the user reads aloud when the call connects. Terminal displays the passphrase and polls the `/call` endpoint:
- Initial delay: 10 seconds (call can't complete faster)
- Backoff: 1.5× each attempt
- Gives up at 60 seconds total, shows a retry button
- Server returns `{ status: "next" }` when the call completes successfully

### PASSWORD
Standard `type="password"` input. Wrapped in `<form autocomplete="off">` with a non-standard field name to suppress browser password-save prompts. Browser renders its own native show/hide toggle.

### VIDEO
Displays `challenge.value` as a phrase the user must say on camera. User taps Start — a 5-second countdown badge overlays the camera feed. Recording stops automatically at 0. Clip is encoded as base64 (`video/webm`) and POSTed as `videoData`. On failure, the user can retry — the camera stream is restarted automatically.

### ENROL
Dynamic form built from `challenge.fields[]`:
```javascript
{ name, label, type: "text"|"email"|"tel"|"number"|"date", required }
```
Collects values and POSTs as `{ ...challenge, data: { fieldName: value } }`. If `challenge.requiresApproval` is true, the complete screen shows a "pending approval" message instead.

---

## UI states

All managed by `_showState(name)` which shows one `#state-{name}` div and hides all others.

| State | Shown when |
|-------|-----------|
| `loading` | Initial load |
| `error` | Session fetch failed, unknown challenge type |
| `used` | `session.used === true` |
| `window` | Current time is outside all location windows |
| `challenge` | Walking the challenge chain |
| `complete` | Server returns `status: "complete"` |
| `failed` | Server returns `status: "failed"` |

---

## What the terminal does NOT do

- Enforce location windows (server does)
- Validate geo distance (server does)
- Send OTP codes or initiate calls (server does)
- Write to the event log (server does)
- Fire webhooks (server does)

---

## Key files

| File | Read this for |
|------|--------------|
| `CONTEXT.md` | Full API reference and session data model |
| `API_REFERENCE.md` | Request and response examples for every challenge type |
| `app.js` | All runtime logic — start here to understand the flow |
| `index.html` | All UI — challenge panels, state screens, styling |

---

*presence.tools — AI context file*
*Keep this file alongside CONTEXT.md when working with an AI assistant on this project.*
