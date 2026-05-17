# presence.tools — Terminal Reference

The terminal is the user-facing app that executes a presence event for a specific identity. It loads a session, walks a chain of challenges, and submits results. All business logic lives server-side.

---

## Hosted or self-hosted

**You don't need to deploy this yourself.**

This terminal is permanently hosted at `app.presence.tools` and is available to all presence.tools customers out of the box. Session links in the format below work immediately — no setup, no infrastructure, no code.

```
https://app.presence.tools/{sessionId}
```

This repository exists for developers who want to **customise or replace** the terminal — to match their own brand, embed it in an existing app, or extend it with additional behaviour. If that's not you, just use the hosted version.

---

## URL Structure

```
https://app.presence.tools/{sessionId}     — hosted, ready to use
https://{your-app-domain}/{sessionId}      — self-hosted
```

The `sessionId` is the only credential. No auth headers, no API keys. The sessionId IS the access token.

---

## API

```
GET  {apiBase}/sessions/{sessionId}
POST {apiBase}/sessions/{sessionId}/{challengeType}
```

`{challengeType}` is the lowercase challenge type: `pin`, `face`, `sms`, `email`, `password`, `video`, `enrol`, `call`.

---

## Flow

### 1. Load session

```
GET {apiBase}/sessions/{sessionId}
```

Returns the full session object. The server marks the session as used on first load — the terminal does not need to do this explicitly.

**If the session doesn't exist or is expired** — show an error screen.  
**If `used: true`** — session has already been completed. Show appropriate message.  
**If current time is outside all location windows** — inform the user they are too early or too late.

### 2. Walk the challenge chain

The session contains `challenges: [{ type, ...options }]`. Render and execute them in order.

Each challenge POSTs to its own endpoint. The body is a JSON array containing only the relevant entries — the GEO entry (if captured) followed by the current challenge:

```json
POST {apiBase}/sessions/{sessionId}/pin

[
  { "type": "GEO", "lat": 51.5074, "lng": -0.1278 },
  { "type": "PIN", "value": "1234", "identityId": "id_abc" }
]
```

`identityId` is included once the server has resolved it from a previous challenge response.

### 3. Handle the response

```javascript
// More challenges remain
{ "status": "next" }

// All challenges passed
{ "status": "complete", "success": true, "confidence": 0.98 }

// Challenge failed
{ "status": "failed", "reason": "PIN_INCORRECT" }
```

If the response includes `identityId`, store it and include it in all subsequent challenge POSTs.

On `complete` or `failed` — the server has already updated the event log and fired the webhook. The terminal just shows the result screen.

---

## Challenge Types

### GEO
Capture the user's location using the browser Geolocation API. GEO never POSTs on its own — coordinates are captured silently and merged into the next challenge's POST body.

```json
{ "type": "GEO", "lat": 51.5074, "lng": -0.1278 }
```

Options:
- `maxDistance` — metres. Server checks distance from event locations.

The terminal does not enforce geo — it captures and submits. The server validates.

---

### FACE
Capture a selfie using the front camera. Submit as base64 JPEG.

```json
{ "type": "FACE", "imageData": "data:image/jpeg;base64,..." }
```

---

### PIN
Render a PIN pad. Submit the PIN value as a string.

```json
{ "type": "PIN", "value": "1234" }
```

---

### SMS / SMS_MFA
Server sends a 4-digit OTP to the identity's phone number. Terminal shows a 4-box code entry field.

```json
{ "type": "SMS", "value": "1234" }
```

The terminal does not send the SMS — the server does when this challenge is reached in the chain.

---

### EMAIL / EMAIL_MFA
Same as SMS but delivered to the identity's email address.

```json
{ "type": "EMAIL", "value": "1234" }
```

---

### CALL
Server initiates an automated voice call. The challenge object contains a passphrase in `value` that the user reads aloud when prompted. The terminal displays the passphrase and polls for completion — the server returns `{ "status": "next" }` when the call is verified.

```json
{ "type": "CALL", "value": "Victor-Xray-Juliet-Whiskey" }
```

---

### PASSWORD
Render a password input field.

```json
{ "type": "PASSWORD", "value": "..." }
```

---

### VIDEO
Display a phrase from `challenge.value`. Record a short clip (max 5 seconds) of the user saying it. Submit as base64.

```json
{ "type": "VIDEO", "value": "Say this phrase", "videoData": "data:video/webm;base64,..." }
```

---

### ENROL
Render a custom form defined by `fields` on the challenge object.

```javascript
{
    "type": "ENROL",
    "requiresApproval": false,
    "fields": [
        { "name": "firstName",  "label": "First name",  "type": "text",  "required": true },
        { "name": "lastName",   "label": "Last name",   "type": "text",  "required": true },
        { "name": "email",      "label": "Email",       "type": "email", "required": true },
        { "name": "employeeId", "label": "Employee ID", "type": "text",  "required": false }
    ]
}
```

Submit the collected form data:

```json
{ "type": "ENROL", "data": { "firstName": "Jane", "lastName": "Smith", "email": "jane@example.com" } }
```

If `requiresApproval: true` — the server creates the identity in pending status. The terminal informs the user their enrolment is pending approval.

---

## Session Object

```javascript
{
    sessionId,
    eventId,
    projectId,
    accountId,
    identityId,       // absent for open/enrol sessions; returned once resolved
    configId,
    name,             // event name — absent if not set
    challenges: [
        { type: 'GEO', maxDistance: 50 },
        { type: 'FACE' },
        { type: 'PIN' },
        { type: 'CALL', value: 'Victor-Xray-Juliet-Whiskey' },
    ],
    locations: [
        {
            locationId,
            window: { opens_at, closes_at },
        }
    ],
    displayName:      'Acme Corp',       // shown in header
    privacyNoticeUrl: 'https://...',     // linked in footer
    used:             false,
}
```

---

## Branding

The terminal renders `displayName` in the header and links `privacyNoticeUrl` in the footer. Both are baked into the session at creation time.

---

## What the terminal does NOT do

- Enforce window times (server does)
- Validate geo distance (server does)
- Send OTP codes or initiate calls (server does)
- Write to the event log (server does)
- Fire webhooks (server does)

The terminal captures, renders, and submits. Nothing more.

---

*presence.tools — Terminal Reference*
