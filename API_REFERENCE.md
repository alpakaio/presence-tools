# presence.tools - API Reference

Base URL: `https://api.dev.presence.tools` (development) · `https://api.presence.tools` (production)

All authenticated endpoints require:
```
Authorization: Bearer <access_token>
x-api-key: <projectId>
```

---

## Authentication

Tokens are project-scoped. Each project has its own credentials and signing secret. Tokens expire after **60 minutes**.

### POST /auth/token

Exchange project credentials for a Bearer token.

**No auth required.**

```json
{
  "grant_type": "client_credentials",
  "account_id": "acc_...",
  "project_id": "proj_...",
  "project_secret": "your-project-secret"
}
```

**Response**
```json
{
  "access_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

### POST /auth/refresh

Refresh an existing token before it expires. Pass the current Bearer token in the `Authorization` header.

**No body required.**

**Response** - same shape as `/auth/token`.

> Tokens can only be refreshed while still valid. If expired, re-authenticate via `/auth/token`.

---

## Configs

A config defines the challenge chain and delivery settings for an event. Create one config and reuse it across many events.

### Challenge types

| Type | What it verifies | Requires on identity |
|---|---|---|
| `GEO` | Device is within `maxDistance` metres of the location | - |
| `FACE` | Biometric face match against enrolled identity images | `images` (indexed) |
| `PIN` | 4-digit PIN known to the identity | `pin` |
| `PASSWORD` | Free-text password known to the identity | `password` |
| `SMS` | One-time code sent to the identity's registered cell | `cell` |
| `EMAIL` | One-time code sent to the identity's registered email | `email` |
| `CALL` | Automated call to identity's cell - reads back 4 NATO words, caller repeats them | `cell` |
| `VIDEO` | Video call verification - identity reads back 4 NATO words on screen | - |
| `ENROL` | Collects form fields from an unknown subject (open events) | - |

> `CALL` and `VIDEO` challenges are stamped with a unique `value` (e.g. `"Bravo-Tango-November-Foxtrot"`) at session creation time. Your terminal reads this to the subject; they repeat it back to confirm.

### ENROL as identity creation

When a session has no `identityId` (open event) and `ENROL` is the first challenge in the chain, the server creates a new identity from the submitted fields and returns the `identityId` in the response. Every challenge that follows becomes a **setter** - PIN sets the identity's PIN, FACE indexes their photo, SMS sets their cell - rather than a getter that verifies against pre-existing data. This is how self-registration flows work: the subject arrives unknown, enrols, and the remaining challenges build out their identity record in a single session.

### Challenge prerequisites

**Most challenges require pre-existing data on the identity.** A challenge will fail at runtime if the required field is not present - there is no fallback. Design your config and identity creation flow together.

| If you want to use... | The identity must have... | Notes |
|---|---|---|
| `PIN` | `pin` set at creation or update | 4-digit numeric |
| `PASSWORD` | `password` set at creation or update | Free text |
| `SMS` | `cell` in E.164 format (e.g. `447777666555`) | Used to send the OTP |
| `EMAIL` | `email` | Used to send the OTP |
| `CALL` | `cell` | Your system places the call; presence provides the words |
| `FACE` | `images` array with at least one indexed photo | Indexing is async - allow time after identity creation before using |
| `GEO` | - | No identity data needed; uses the device location at challenge time |
| `VIDEO` | - | Your system handles the call; presence provides the words |
| `ENROL` | - | For open events only - captures data from unknown subjects |

**Design principle:** match your challenge chain to the data you actually have. A check-in flow where you know the worker in advance (closed event) can use `PIN`, `SMS`, or `FACE`. A visitor flow where the subject is unknown should use `GEO` + `ENROL`, not `PIN` or `CALL`. Mixing challenges that require identity data into an open event will fail for every subject.

### Delivery options

Presence fires the full event object to your system on every state change. Three delivery targets are supported - configure one or more per config.

| Target | Fields |
|---|---|
| Webhook | `webhook.url`, `webhook.secret` |
| AWS EventBridge | `aws.roleArn`, `aws.eventBridgeBus` |
| AWS SQS | `aws.roleArn`, `aws.sqsQueueUrl` |

AWS delivery uses cross-account IAM role assumption - no credentials are stored on the platform.

---

### GET /configs

List all configs for the account.

**Response**
```json
{
  "configs": [{ "configId": "...", "name": "Standard check-in", "challenges": [...], ... }],
  "count": 1,
  "cursor": null
}
```

---

### POST /configs

Create a config.

```json
{
  "name": "Standard check-in",
  "challenges": [
    { "type": "GEO", "maxDistance": 50 },
    { "type": "FACE" }
    /* 
    { type: 'SMS' }
    { type: 'EMAIL' }
    { type: 'CALL' }
    { type: 'PASSWORD' }
    { type: 'PIN' }
    { type: 'VIDEO' }
    { type: 'ENROL', fields: [
        { name: 'firstName',  label: 'First name',  type: 'text',  required: true },
        { name: 'lastName',   label: 'Last name',   type: 'text',  required: true },
        { name: 'email',      label: 'Email',       type: 'email', required: true },
        { name: 'employeeId', label: 'Employee ID', type: 'text',  required: false },
    ]}
    */
  ],
  "webhook": {
    "url": "https://your-app.com/webhooks/presence",
    "secret": "your-webhook-secret"
  },
  "aws": {
    "roleArn": null,
    "eventBridgeBus": null,
    "sqsQueueUrl": null
  }
}
```

All fields except `name` are optional. `challenges` defaults to `[]`.

**Response** `201` - the created config object.

---

### GET /configs/{id}

Fetch a single config.

**Response** `200` - the config object.

---

### PUT /configs/{id}

Update config fields. Pass only the fields you want to change.

```json
{ "name": "Strict check-in" }
```

**Response** `200` - the updated config object.

---

### DELETE /configs/{id}

Soft-delete a config. The record is retained for 30 days then permanently removed.

**Response** `200` - the deleted config object with `active: false`.

---

## Locations

A location is a named physical place. Presence enriches it with coordinates, geohash, timezone, and reverse geocode on creation.

### Input priority

Supply coordinates one of three ways - in priority order:

1. `geolocation.lat` + `geolocation.lng`
2. `geolocation.placeId` (Google Maps place ID)
3. `geolocation.w3w` (what3words address)

All paths are enriched with a reverse geocode (placeId, plusCode) and timezone automatically.

---

### GET /locations

List all locations in the project.

**Response**
```json
{
  "locations": [{ "locationId": "...", "name": "Warehouse A", ... }],
  "count": 1,
  "cursor": null
}
```

Use `?cursor=<token>` and `?limit=<n>` (max 100) for pagination.

---

### POST /locations

Create a location.

```json
{
  "name": "Warehouse A",
  "external": "site-001",
  "geolocation": {
    "lat": 51.5074,
    "lng": -0.1278,
    "placeId": null,
    "w3w": null
  },
  "address": {
    "add1": "1 Example Street",
    "add2": null,
    "add3": null,
    "city": "London",
    "state": null,
    "zip": "EC1A 1BB",
    "country": "GB"
  }
}
```

`external` is your own reference ID - useful for linking to your internal system.

**Response** `201` - the created location object, enriched with `geohash`, `timezone`, `placeId`, and `plusCode`.

---

### GET /locations/{id}

Fetch a single location.

**Response** `200` - the location object.

---

### PUT /locations/{id}

Update location fields. Pass only the fields you want to change.

```json
{ "name": "Warehouse A - North Wing" }
```

**Response** `200` - the updated location object.

---

### DELETE /locations/{id}

Soft-delete a location. The record is retained for 30 days then permanently removed.

**Response** `200` - the deleted location object with `active: false`.

---

## Identities

An identity is a known subject - an employee, contractor, visitor, or any named individual. Identities are scoped to a project.

### Uniqueness

The following fields are **unique per project** - a `409` is returned if a duplicate is detected on POST or PUT:

- `email`
- `cell`
- `pin`
- `external`

### Face enrolment

Supply `images` as an array of HTTPS URLs pointing to photos of the subject. Presence fetches and indexes these asynchronously after the identity is created. Once indexed, the `FACE` challenge is available for this identity.

---

### GET /identities

List all identities in the project.

**Response**
```json
{
  "identities": [{ "identityId": "...", "name": { "first": "Jane", "last": "Smith" }, ... }],
  "count": 1,
  "cursor": null
}
```

Use `?cursor=<token>` and `?limit=<n>` (max 100) for pagination.

---

### POST /identities

Create an identity.

```json
{
  "external": "your-internal-id",
  "name": { "first": "Jane", "last": "Smith" },
  "email": "jane@example.com",
  "cell": "447777666555",
  "pin": "1234",
  "images": ["https://your-cdn.com/photo.jpg"],
  "ttl": null,
  "meta": {
    "department": "Engineering",
    "accessLevel": "standard"
  }
}
```

All fields are optional. `cell` should be in E.164 format without the `+` prefix (e.g. `447777666555`). `meta` is a free-form object for your own data.

**Response** `201` - the created identity object.

---

### GET /identities/{id}

Fetch a single identity.

**Response** `200` - the identity object.

---

### PUT /identities/{id}

Update identity fields. Pass only the fields you want to change.

```json
{ "name": { "first": "Jane", "last": "Jones" } }
```

**Response** `200` - the updated identity object.

---

### DELETE /identities/{id}

Soft-delete an identity. The record is retained for 30 days then permanently removed.

**Response** `200` - the deleted identity object with `active: false`.

---

## Events

An event is the core unit of work. It defines who should be verified (`identities`), where (`locations`), and using which challenge chain (`configId`). Progress is tracked automatically - you never write to `progress` or `log`.

### The event object

```json
{
  "eventId": "...",
  "configId": "...",
  "name": "morning-shift-2026-05-17",
  "locations": [
    {
      "locationId": "...",
      "window": {
        "opens_at": "2026-05-17T06:00:00.000Z",
        "closes_at": "2026-05-17T14:00:00.000Z"
      }
    }
  ],
  "identities": ["identityId-1", "identityId-2"],
  "progress": {
    "total": 2,
    "completed": 0,
    "success": 0,
    "failure": 0
  },
  "log": [
    { "type": "EVENT_CREATED", "timestamp": "2026-05-17T05:00:00.000Z" }
  ],
  "sessions": [
    { "sessionId": "a3f9kz", "identityId": "...", "url": "https://app.presence.tools/a3f9kz" }
  ],
  "external": null,
  "ttl": null
}
```

### Open vs closed events

| | Closed | Open |
|---|---|---|
| `identities` | One or more IDs | Empty array `[]` |
| `progress.total` | `locations × identities` | `null` |
| Who can verify | Named identities only | Anyone |
| Challenge mode | Getter - verifies against existing identity data | Setter - ENROL creates the identity; subsequent challenges populate it |

### Sessions

When an event is created, a session is generated for each `identity × event` combination (or one open session if `identities` is empty). Each session has a short URL - distribute these to subjects. The terminal at that URL runs the challenge chain.

---

### GET /events

List all active events in the project.

**Response**
```json
{
  "events": [{ "eventId": "...", ... }],
  "count": 1,
  "cursor": null
}
```

Use `?cursor=<token>` and `?limit=<n>` (max 100) for pagination.

---

### POST /events

Create an event.

```json
{
  "configId": "cfg_...",
  "name": "morning-shift-2026-05-17",
  "locations": [
    {
      "locationId": "loc_...",
      "window": {
        "opens_at": "2026-05-17T06:00:00.000Z",
        "closes_at": "2026-05-17T14:00:00.000Z"
      }
    }
  ],
  "identities": ["idn_...", "idn_..."],
  "external": null,
  "ttl": null
}
```

- `configId` is required. Everything else is optional.
- `locations` and `identities` can be empty arrays - an empty `identities` array creates an open event.
- `ttl` is a Unix timestamp. If omitted, defaults to `now + project.eventRetentionDays`. Cannot exceed that default.
- `progress` and `log` are **server-managed** - do not send them.

**Response** `201` - the full event object including generated `sessions`.

---

### GET /events/{id}

Fetch a single event, including current `progress` and full `log`.

**Response** `200` - the event object.

---

### PUT /events/{id}

Update event fields. `progress` and `log` cannot be overwritten.

If you update `locations`, only sessions where the location window has not yet been responded to will be patched - completed sessions are locked.

```json
{
  "locations": [
    {
      "locationId": "loc_...",
      "window": {
        "opens_at": "2026-05-17T07:00:00.000Z",
        "closes_at": "2026-05-17T15:00:00.000Z"
      }
    }
  ]
}
```

**Response** `200` - the updated event object.

---

### DELETE /events/{id}

Soft-delete an event and all associated sessions.

**Response** `200` - the deleted event object with `active: false`.

---

## Sessions

Sessions are the verification terminal. Each session is a challenge chain scoped to a specific event, location, and identity. Session endpoints are **unauthenticated** - they are designed to be hit directly by the terminal running at the session URL.

### GET /sessions/{sessionId}

Fetch the session state. The terminal uses this to know which challenges to present and in what order.

`sessionId` is the 6-character alphanumeric code embedded in the session URL (e.g. `a3f9kz`).

**No auth required.**

**Response**
```json
{
  "sessionId": "a3f9kz",
  "eventId": "...",
  "configId": "...",
  "identityId": "...",
  "challenges": [
    { "type": "GEO", "maxDistance": 50 },
    { "type": "FACE" }
  ],
  "locations": [
    {
      "locationId": "...",
      "window": { "opens_at": "...", "closes_at": "..." }
    }
  ],
  "displayName": "Acme Corp",
  "privacyNoticeUrl": "https://acme.com/privacy",
  "url": "https://app.presence.tools/a3f9kz",
  "used": false
}
```

---

### Challenge submission endpoints

All challenge endpoints follow the same pattern:

```
POST /sessions/{sessionId}/{challengeType}
```

**No auth required.**

**Response** `200`
```json
{ "status": "next" }
```

`status` values indicate what the terminal should do next:
- `next` - challenge accepted, proceed to next challenge
- `complete` - all challenges passed, session done
- `failed` - challenge failed

#### POST /sessions/{sessionId}/geo

```json
{
  "lat": 51.5074,
  "lng": -0.1278
}
```

Verifies the device is within `maxDistance` metres of the event location.

---

#### POST /sessions/{sessionId}/face

```json
{
  "image": "data:image/jpeg;base64,/9j/4AAQ..."
}
```

Base64-encoded image of the subject's face. Matched against enrolled `images` on the identity.

---

#### POST /sessions/{sessionId}/pin

```json
{ "pin": "1234" }
```

---

#### POST /sessions/{sessionId}/password

```json
{ "password": "correct-horse-battery-staple" }
```

---

#### POST /sessions/{sessionId}/sms

Two-step: trigger the OTP send, then submit the code.

```json
{ "code": "483921" }
```

---

#### POST /sessions/{sessionId}/email

Two-step: trigger the OTP send, then submit the code.

```json
{ "code": "294810" }
```

---

#### POST /sessions/{sessionId}/call

The session object contains a `value` field on the CALL challenge - four NATO words (e.g. `"Bravo-Tango-November-Foxtrot"`). Your automated call reads these words to the subject. Submit what the subject spoke back.

```json
{ "value": "Bravo-Tango-November-Foxtrot" }
```

---

#### POST /sessions/{sessionId}/video

Same as CALL. The session object contains a `value` on the VIDEO challenge - four NATO words displayed on screen. Submit what the subject read back.

```json
{ "value": "Golf-Sierra-Kilo-Delta" }
```

---

#### POST /sessions/{sessionId}/enrol

Submits a free-form field collection from an unknown subject. Fields are defined in the config's `ENROL` challenge.

```json
{
  "fields": {
    "name": "John Smith",
    "company": "Acme Ltd",
    "purpose": "Delivery"
  }
}
```

---

## Error responses

All endpoints return errors in this shape:

```json
{
  "error": "invalid_request",
  "error_description": "Missing required fields: configId"
}
```

| Status | Error | Meaning |
|---|---|---|
| `400` | `invalid_request` | Missing or invalid fields |
| `401` | `invalid_project` / `invalid_token` | Auth failed |
| `403` | - | API key missing or invalid |
| `404` | `not_found` | Resource does not exist |
| `409` | `conflict` | Uniqueness violation (email, cell, pin, external) |
| `500` | `server_error` | Unexpected error - check CloudWatch |

---

*presence.tools API Reference - Last updated May 2026*
