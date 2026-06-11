# VIDEO Challenge — What the API needs from the app

## Before recording

Call `GET /events/{eventId}/sessions/{sessionId}/video/challenge` to get a token.

```json
{ "token": "a3f9kz2b", "expiresAt": "2026-05-26T10:13:47.237Z" }
```

The token expires in 60 seconds. Fetch it immediately before the user starts recording — not on page load.

## What to record

Show the four NATO words from `challenge.value` (e.g. `"Bravo-Tango-November-Foxtrot"`) prominently on screen. The user must read them aloud while the camera is recording.

## What to submit

```json
POST /events/{eventId}/sessions/{sessionId}
{
  "type": "VIDEO",
  "token": "a3f9kz2b",
  "frame": "data:image/jpeg;base64,...",
  "video": "data:video/webm;base64,..."
}
```

- `frame` — a single JPEG image captured from the video (for face matching)
- `video` — the full video file as base64 webm (for audio transcription)
- `token` — the value returned by the GET above

## How the server assesses it

In parallel:
1. Rekognition face match on `frame` against the identity's enrolled face — must match with ≥ 90% confidence
2. Whisper transcription of the audio in `video` — transcript must fuzzy-match all four NATO words

Both must pass. If either fails, `passed: false`.

## Nonce rules

- Single use — consumed on first submission regardless of pass/fail
- 60 second expiry from issue time
- If the user takes too long, fetch a new token and let them try again
