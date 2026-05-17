/**
 * presence.tools — Terminal
 * =========================
 * Reference implementation of the session terminal.
 * Reads a sessionId from the URL path, loads the session from the API,
 * then walks the challenge chain until the server returns complete or failed.
 *
 * Architecture: one plain JS object (PresenceApp) with no framework, no
 * bundler, no build step. Every method is documented so you can lift
 * individual pieces into your own stack.
 *
 * Flow:
 *   init() → fetchSession() → showSession() → runChallenge() → respond()
 *                                                    ↑______________|
 *                                                    (loops until complete/failed)
 */

const PresenceApp = {

  // ─── Configuration ────────────────────────────────────────────────────────

  /**
   * Resolve the API base URL from the current hostname.
   *
   * Rule: if the app is running on *.dev.*, hit the dev API.
   * Otherwise, assume production. This means the same static bundle
   * works in both environments — no environment-specific build needed.
   *
   * Dev:  app.dev.presence.tools  → api.dev.presence.tools
   * Prod: app.presence.tools      → api.presence.tools
   */
  get apiBase() {
    const isFile      = window.location.protocol === 'file:';
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    return (isFile || isLocalhost || window.location.hostname.includes('.dev.'))
      ? 'https://api.dev.presence.tools'
      : 'https://api.presence.tools';
  },

  // ─── State ─────────────────────────────────────────────────────────────────

  /** The sessionId extracted from the URL path. */
  _sessionId: null,

  /** The full session object returned by GET /sessions/{sessionId}. */
  _session: null,

  /**
   * Index into session.challenges — tracks where we are in the chain.
   * Starts at 0. Advances each time the server returns { status: "next" }.
   */
  _challengeIndex: 0,

  /**
   * Coordinates captured by a GEO challenge, held until the next challenge
   * submits. GEO never POSTs on its own — the coords are merged into the
   * next challenge's payload so the server receives identity + location together.
   * Cleared after each use.
   */
  _pendingGeo: null,

  // ─── Entry point ───────────────────────────────────────────────────────────

  /**
   * Called on DOMContentLoaded.
   * Extracts the sessionId, fetches the session, then hands off to showSession().
   */
  async init() {
    this._sessionId = this._getSessionId();

    if (!this._sessionId) {
      this._showState('error', 'No session ID found in the URL.');
      return;
    }

    try {
      this._session = await this._fetchSession(this._sessionId);
      this._showSession();
    } catch (err) {
      console.error('[PresenceApp] Failed to load session:', err);
      this._showState('error', err.message || 'Could not load session. Please try again.');
    }
  },

  // ─── Session loading ───────────────────────────────────────────────────────

  /**
   * Extract the sessionId from the URL.
   *
   * Primary:   /abc123            → parts[0] = "abc123"
   * Fallback:  ?sessionId=abc123  → query param (useful during local dev)
   *
   * We ignore the path when running from file:// (local double-click open)
   * because the path will be a filesystem path, not a session ID.
   */
  _getSessionId() {
    const isFile = window.location.protocol === 'file:';
    const params = new URLSearchParams(window.location.search);
    const parts  = window.location.pathname.replace(/^\//, '').split('/');
    return (!isFile && parts[0]) || params.get('sessionId') || null;
  },

  /**
   * GET /sessions/{sessionId}
   *
   * The server sets used: true on first load — we don't need to do anything
   * extra to mark the session consumed. The GET itself is the trigger.
   */
  async _fetchSession(sessionId) {
    const res = await fetch(`${this.apiBase}/sessions/${sessionId}`);

    if (res.status === 404) throw new Error('Session not found or expired.');
    if (!res.ok)           throw new Error(`Server error (${res.status})`);

    return res.json();
  },

  // ─── Session display ───────────────────────────────────────────────────────

  /**
   * Inspect the loaded session and decide what to show.
   *
   * Decision tree:
   *  1. session.used      → show "already used" screen
   *  2. outside window    → show "too early / too late" screen
   *  3. otherwise         → apply branding, start challenge chain
   */
  _showSession() {
    const session = this._session;

    // Apply branding regardless of outcome — the header/footer show the
    // client's name and privacy link even on error screens.
    this._applyBranding(session);

    if (session.used) {
      this._showState('used');
      return;
    }

    const windowState = this._getWindowState(session.locations);
    if (windowState !== 'open') {
      this._showWindowState(windowState, session.locations);
      return;
    }

    // All good — start the challenge chain from index 0.
    this._challengeIndex = 0;
    this._runChallenge();
  },

  /**
   * Write branding values from the session into the DOM.
   * displayName → header h1
   * privacyNoticeUrl → footer link (footer hidden if absent)
   */
  _applyBranding(session) {
    if (session.displayName) {
      document.getElementById('display-name').textContent = session.displayName;
      document.getElementById('app-header').classList.remove('hidden');
    }

    if (session.privacyNoticeUrl) {
      document.getElementById('privacy-link').href = session.privacyNoticeUrl;
      document.getElementById('app-footer').classList.remove('hidden');
    }
  },

  // ─── Window / time checks ─────────────────────────────────────────────────

  /**
   * Determine whether the current time falls inside any location's window.
   *
   * Returns:
   *   'open'    — at least one window is currently open
   *   'early'   — all windows are in the future
   *   'late'    — all windows have closed
   *   'no-windows' — no locations defined (session has no time constraint)
   *
   * The terminal doesn't enforce this — the server will reject out-of-window
   * responses anyway. We check here to give a friendlier early message.
   */
  _getWindowState(locations) {
    if (!locations || locations.length === 0) return 'open';

    const now = Date.now();
    let anyFuture = false;
    let anyPast   = false;

    for (const loc of locations) {
      if (!loc.window) continue; // no time constraint on this location

      const opens  = new Date(loc.window.opens_at).getTime();
      const closes = new Date(loc.window.closes_at).getTime();

      if (now >= opens && now <= closes) return 'open'; // inside a window → done
      if (now < opens)  anyFuture = true;
      if (now > closes) anyPast   = true;
    }

    if (anyFuture && !anyPast) return 'early';
    if (anyPast)               return 'late';
    return 'open'; // all locations have no window constraints
  },

  /**
   * Show the window-state screen with appropriate messaging.
   */
  _showWindowState(state, locations) {
    document.getElementById('window-heading').textContent =
      state === 'early' ? 'You\'re a little early' : 'This session has closed';

    // Find the next opening / last close to give the user context.
    const times = (locations || [])
      .filter(l => l.window)
      .map(l => ({
        opens:  new Date(l.window.opens_at),
        closes: new Date(l.window.closes_at),
      }));

    let message = '';
    if (state === 'early' && times.length > 0) {
      const next = times.reduce((a, b) => a.opens < b.opens ? a : b);
      message = `This session opens at ${this._formatTime(next.opens)}.`;
    } else if (state === 'late' && times.length > 0) {
      const last = times.reduce((a, b) => a.closes > b.closes ? a : b);
      message = `This session closed at ${this._formatTime(last.closes)}.`;
    }

    document.getElementById('window-message').textContent = message;
    this._showState('window');
  },

  /** Format a Date as a human-readable time string in the user's local timezone. */
  _formatTime(date) {
    return date.toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  },

  // ─── Challenge chain ───────────────────────────────────────────────────────

  /**
   * Render the current challenge.
   *
   * Challenges come from session.challenges[] in order. We track position
   * with _challengeIndex. Each call to _runChallenge() renders one challenge
   * and wires up its submit handler.
   *
   * When the server returns { status: "next" }, we advance _challengeIndex
   * and call _runChallenge() again. This is the loop.
   */
  _runChallenge() {
    const challenges = this._session.challenges;
    const challenge  = challenges[this._challengeIndex];

    if (!challenge) {
      // No more challenges — this shouldn't happen normally because the
      // server sends { status: "complete" } on the last one, but guard anyway.
      this._showState('complete');
      return;
    }

    // Update the progress bar before showing the challenge UI.
    this._updateProgress(this._challengeIndex, challenges.length);

    // Show the challenge panel.
    this._showState('challenge');

    // Delegate to the type-specific renderer.
    const type = challenge.type;
    const handler = this._challengeHandlers[type];

    if (!handler) {
      // Unknown challenge type — surface it clearly so developers can debug.
      this._showState('error', `Unknown challenge type: "${type}". Is your terminal up to date?`);
      return;
    }

    // Hide all challenge panels, then show the right one.
    document.querySelectorAll('[id^="challenge-"]').forEach(el => el.classList.add('hidden'));

    handler.call(this, challenge);
  },

  /**
   * Update the progress bar and label.
   * index is 0-based; total is session.challenges.length.
   */
  _updateProgress(index, total) {
    const step    = index + 1;
    const pct     = (step / total) * 100;

    document.getElementById('progress-bar-fill').style.width = `${pct}%`;
    document.getElementById('progress-label').textContent    = `${step} of ${total}`;
  },

  // ─── API: submit a challenge response ─────────────────────────────────────

  /**
   * POST /sessions/{sessionId}/{type}  (e.g. /pin, /face, /SMS)
   *
   * Body is a challenges array: always just the GEO entry (if captured) plus
   * this challenge with its captured value populated. Sending only these two
   * avoids putting the full chain — including other blobs — over the wire.
   *
   *   POST /sessions/abc123/pin
   *   [
   *     { "type": "GEO", "lat": 51.5, "lng": -0.1 },
   *     { "type": "PIN", "value": "1234" }
   *   ]
   *
   * Each challenge type has its own endpoint so server-side handlers can be
   * isolated independently (separate Lambdas, IAM policies, etc.).
   *
   * Server response:
   *   { status: "next",     challenge: { type } }         → advance
   *   { status: "complete", success: true, confidence }   → done
   *   { status: "failed",   reason: "PIN_INCORRECT" }     → rejected
   */
  async _respond(challenge) {
    // Build the challenges array: GEO first (if captured), then this challenge.
    // identityId is appended to each challenge entry once the server has
    // resolved it — this scopes subsequent verifications to that identity.
    const identityId = this._session.identityId;
    const body = [];
    if (this._pendingGeo) {
      body.push({ type: 'GEO', ...this._pendingGeo, ...(identityId && { identityId }) });
      this._pendingGeo = null;
    }
    body.push({ ...challenge, ...(identityId && { identityId }) });

    // Endpoint is the lowercase challenge type: /sessions/{id}/pin, /face, etc.
    const endpoint = challenge.type.toLowerCase();

    const res = await fetch(`${this.apiBase}/sessions/${this._sessionId}/${endpoint}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Server error (${res.status})`);
    return res.json();
  },

  /**
   * Handle the server's response after a challenge submission.
   *
   * Called by every challenge handler after a successful _respond() call.
   * Centralises the status-routing logic so individual handlers stay lean.
   */
  _handleResponse(result) {
    // If the server resolved an identity from this challenge, store it on the
    // session so all subsequent challenge POSTs include it in the body.
    if (result.identityId) {
      this._session.identityId = result.identityId;
    }

    if (result.status === 'next') {
      this._challengeIndex++;
      this._runChallenge();

    } else if (result.status === 'complete') {
      if (result.confidence != null) {
        const conf = document.getElementById('complete-confidence');
        conf.textContent = `Confidence: ${Math.round(result.confidence * 100)}%`;
        conf.classList.remove('hidden');
      }
      this._showState('complete');

    } else if (result.status === 'failed') {
      // Map server reason codes to human-readable copy.
      const reasons = {
        PIN_INCORRECT:   'Incorrect PIN. Please contact the event organiser.',
        FACE_NOT_FOUND:  'We couldn\'t match your face. Please try again.',
        FACE_LOW_CONF:   'Face match confidence too low. Please try again in better lighting.',
        OTP_INCORRECT:   'Incorrect code. Please check and try again.',
        OTP_EXPIRED:     'That code has expired. Please request a new one.',
        PASSWORD_WRONG:  'Incorrect password.',
        GEO_TOO_FAR:     'You\'re not in the right location for this event.',
      };
      const message = reasons[result.reason] || `Verification failed (${result.reason || 'unknown'}).`;
      document.getElementById('failed-message').textContent = message;
      this._showState('failed');

    } else {
      this._showState('error', 'Unexpected response from server.');
    }
  },

  // ─── Challenge handlers ────────────────────────────────────────────────────

  /**
   * Each handler receives the challenge object from session.challenges[].
   * It is responsible for:
   *   1. Showing the right #challenge-X panel
   *   2. Collecting input from the user
   *   3. Calling _respond() with the right payload
   *   4. Calling _handleResponse() with the result
   *
   * Handlers set a status message via a #xxx-status element while working.
   */
  _challengeHandlers: {

    // ── GEO ────────────────────────────────────────────────────────────────

    /**
     * GEO: capture coordinates silently in the background, then immediately
     * advance to the next challenge. The coords are held in _pendingGeo and
     * merged into the next challenge's POST payload by _respond().
     *
     * GEO never renders a UI panel and never POSTs on its own — it always
     * accompanies an identity challenge (FACE, PIN, etc.) in the chain.
     *
     * enableHighAccuracy: true requests GPS rather than cell/wifi triangulation,
     * needed for tight maxDistance constraints (e.g. < 50m).
     */
    async GEO(challenge) {
      try {
        const pos = await new Promise((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 15000,
          })
        );
        PresenceApp._pendingGeo = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      } catch (err) {
        // Non-fatal: if the user denies or location is unavailable, we advance
        // anyway without coords. The server will decide whether to reject.
        console.warn('[PresenceApp] GEO capture failed:', err);
        PresenceApp._pendingGeo = null;
      }

      // Advance immediately — no user interaction required.
      PresenceApp._challengeIndex++;
      PresenceApp._runChallenge();
    },

    // ── FACE ───────────────────────────────────────────────────────────────

    /**
     * FACE: open the front camera, capture a JPEG frame via canvas, send base64.
     *
     * getUserMedia with facingMode: "user" requests the front/selfie camera.
     * We draw a single video frame onto a hidden canvas, then export it as JPEG.
     * quality: 0.85 balances file size vs. recognition accuracy.
     *
     * The server runs Rekognition SearchFacesByImage against the project's
     * face collection and returns a confidence score.
     */
    async FACE(challenge) {
      const panel   = document.getElementById('challenge-FACE');
      const video   = document.getElementById('face-preview');
      const canvas  = document.getElementById('face-canvas');
      const btn     = document.getElementById('face-btn');
      const status  = document.getElementById('face-status');

      panel.classList.remove('hidden');

      // Start camera stream.
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user' },
          audio: false,
        });
        video.srcObject = stream;
      } catch (err) {
        status.textContent = 'Camera permission denied. Please allow access and reload.';
        btn.disabled = true;
        return;
      }

      btn.addEventListener('click', async () => {
        btn.disabled = true;
        status.textContent = 'Capturing…';

        // Match canvas size to video feed to avoid distortion.
        canvas.width  = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);

        const imageData = canvas.toDataURL('image/jpeg', 0.85);

        // Stop the camera stream — free the hardware before the network call.
        video.srcObject.getTracks().forEach(t => t.stop());

        status.textContent = 'Submitting…';

        try {
          const result = await PresenceApp._respond({ ...challenge, imageData });
          PresenceApp._handleResponse(result);
        } catch (err) {
          status.textContent = 'Failed to submit photo. Please try again.';
          btn.disabled = false;
        }
      });
    },

    // ── PIN ────────────────────────────────────────────────────────────────

    /**
     * PIN: custom PIN pad (no OS keyboard).
     *
     * We build a dot-display to show how many digits have been entered without
     * revealing the digits themselves. The submit button activates once the
     * user has entered at least one digit (server determines required length).
     *
     * We don't enforce a specific length client-side — that's the server's job.
     */
    PIN(challenge) {
      const panel   = document.getElementById('challenge-PIN');
      const display = document.getElementById('pin-display');
      const submit  = document.getElementById('pin-submit');
      const back    = document.getElementById('pin-back');
      const status  = document.getElementById('pin-status');

      panel.classList.remove('hidden');

      let pin = '';

      /** Redraw the dot display to reflect current pin length. */
      function updateDisplay() {
        // Show one dot per entered digit, plus one empty dot as the next slot.
        // This way the length is never revealed — it just grows as you type.
        const total = pin.length + 1;
        display.innerHTML = Array.from({ length: total }, (_, i) =>
          `<div class="w-3.5 h-3.5 rounded-full border-2 ${
            i < pin.length ? 'bg-gray-900 border-gray-900' : 'border-gray-300'
          }"></div>`
        ).join('');

        submit.disabled = pin.length === 0;
      }

      updateDisplay();

      // Digit keys: data-value is set in the event delegation below.
      document.querySelectorAll('.pin-key').forEach(key => {
        if (key === back) return; // handled separately
        key.addEventListener('click', () => {
          if (pin.length >= 8) return;
          pin += key.textContent;
          updateDisplay();
        });
      });

      back.addEventListener('click', () => {
        pin = pin.slice(0, -1);
        updateDisplay();
      });

      submit.addEventListener('click', async () => {
        submit.disabled = true;
        status.textContent = 'Checking…';

        try {
          const result = await PresenceApp._respond({ ...challenge, value: pin });
          PresenceApp._handleResponse(result);
        } catch (err) {
          status.textContent = 'Failed to submit. Please try again.';
          pin = '';
          updateDisplay();
        }
      });
    },

    // ── SMS ────────────────────────────────────────────────────────────

    /**
     * SMS: OTP delivered via SMS.
     *
     * The server sends the SMS when this challenge is reached in the chain.
     * We just show an input field. autocomplete="one-time-code" enables
     * iOS and Android to offer autofill from the SMS notification.
     */
    SMS(challenge) {
      document.getElementById('otp-heading').textContent = 'Check your messages';
      document.getElementById('otp-subheading').textContent =
        'We\'ve sent a verification code to your phone. Enter it below.';
      PresenceApp._challengeHandlers._OTP.call(this, challenge);
    },

    // SMS is the short form used by the session — same UI as SMS.
    SMS(challenge) { PresenceApp._challengeHandlers.SMS.call(this, challenge); },

    // ── EMAIL ──────────────────────────────────────────────────────────

    EMAIL(challenge) {
      document.getElementById('otp-heading').textContent = 'Check your email';
      document.getElementById('otp-subheading').textContent =
        'We\'ve sent a verification code to your email address. Enter it below.';
      PresenceApp._challengeHandlers._OTP.call(this, challenge);
    },

    // EMAIL is the short form used by the session — same UI as EMAIL.
    EMAIL(challenge) { PresenceApp._challengeHandlers.EMAIL.call(this, challenge); },

    // ── CALL ───────────────────────────────────────────────────────────────

    /**
     * CALL: the server initiates a voice call containing a spoken prompt.
     * The challenge object includes `value` — a passphrase the user reads aloud.
     *
     * Polling strategy:
     *   - Wait 10s before first poll (call can't complete faster than that)
     *   - Poll with exponential backoff: 10s → 15s → 22s → ...
     *   - Give up after 60s total elapsed, show a retry button
     *   - Retry restarts the whole sequence from scratch
     *
     * The server returns { status: "next" } when the call completes successfully.
     */
    CALL(challenge) {
      const panel  = document.getElementById('challenge-CALL');
      const status = document.getElementById('call-status');
      const retry  = document.getElementById('call-retry');

      document.getElementById('call-passphrase').textContent = challenge.value || '';
      panel.classList.remove('hidden');

      function startPolling() {
        retry.classList.add('hidden');
        status.textContent = 'Waiting for the call to complete…';

        const INITIAL_DELAY  = 10000; // ms before first poll
        const BACKOFF_FACTOR = 1.5;   // multiply interval each attempt
        const GIVE_UP_AFTER  = 60000; // ms total before showing retry

        let elapsed  = 0;
        let interval = INITIAL_DELAY;
        let timer;

        function scheduleNext() {
          timer = setTimeout(async () => {
            elapsed += interval;

            try {
              const result = await PresenceApp._respond({ ...challenge });
              if (result.status === 'next' || result.status === 'complete' || result.status === 'failed') {
                // Server has resolved — hand off to the standard response handler.
                PresenceApp._handleResponse(result);
                return;
              }
              // status === something unexpected — keep polling if time remains
            } catch (err) {
              // Network error — keep polling silently, don't alarm the user
              console.warn('[PresenceApp] CALL poll error:', err);
            }

            if (elapsed >= GIVE_UP_AFTER) {
              status.textContent = 'We couldn\'t confirm the call completed. Please try again.';
              retry.classList.remove('hidden');
              return;
            }

            // Back off and schedule the next attempt.
            interval = Math.round(interval * BACKOFF_FACTOR);
            scheduleNext();

          }, interval);
        }

        scheduleNext();

        // Return a cancel function so retry can clear the pending timer.
        return () => clearTimeout(timer);
      }

      let cancel = startPolling();

      retry.addEventListener('click', () => {
        cancel(); // clear any pending timer from the previous attempt
        cancel = startPolling();
      });
    },

    /**
     * Shared OTP handler — used by SMS, SMS, EMAIL, EMAIL.
     *
     * 4-box MFA input: each box accepts one digit. Typing advances focus
     * to the next box automatically. Backspace moves focus back.
     * autocomplete="one-time-code" on the first box lets iOS/Android autofill
     * the entire code from an SMS notification.
     */
    _OTP(challenge) {
      const panel  = document.getElementById('challenge-OTP');
      const boxes  = Array.from(document.querySelectorAll('.otp-box'));
      const submit = document.getElementById('otp-submit');
      const status = document.getElementById('otp-status');

      panel.classList.remove('hidden');

      // Reset all boxes and state from any previous OTP challenge.
      boxes.forEach(b => b.value = '');
      submit.disabled    = true;
      status.textContent = '';

      function currentCode() { return boxes.map(b => b.value).join(''); }

      boxes.forEach((box, i) => {
        box.addEventListener('input', () => {
          // Keep only the last digit typed (handles paste-one-char edge case).
          box.value = box.value.replace(/\D/g, '').slice(-1);

          if (box.value && i < boxes.length - 1) {
            boxes[i + 1].focus();
          }

          submit.disabled = currentCode().length < boxes.length;
        });

        box.addEventListener('keydown', e => {
          if (e.key === 'Backspace' && !box.value && i > 0) {
            boxes[i - 1].focus();
          }
        });

        // Handle SMS autofill: iOS pastes the full code into the first box.
        // Split it across all boxes automatically.
        box.addEventListener('paste', e => {
          const pasted = (e.clipboardData || window.clipboardData)
            .getData('text').replace(/\D/g, '');
          if (pasted.length >= boxes.length) {
            e.preventDefault();
            boxes.forEach((b, j) => b.value = pasted[j] || '');
            submit.disabled = currentCode().length < boxes.length;
            boxes[boxes.length - 1].focus();
          }
        });
      });

      submit.addEventListener('click', async () => {
        submit.disabled    = true;
        status.textContent = 'Verifying…';

        try {
          const result = await PresenceApp._respond({ ...challenge, value: currentCode() });
          PresenceApp._handleResponse(result);
        } catch (err) {
          status.textContent = 'Failed to verify. Please try again.';
          submit.disabled = false;
        }
      });

      setTimeout(() => boxes[0].focus(), 300);
    },

    // ── PASSWORD ───────────────────────────────────────────────────────────

    PASSWORD(challenge) {
      const panel   = document.getElementById('challenge-PASSWORD');
      const input   = document.getElementById('password-input');
      const submit  = document.getElementById('password-submit');
      const status  = document.getElementById('password-status');

      panel.classList.remove('hidden');

      input.value        = '';
      submit.disabled    = true;
      status.textContent = '';

      input.addEventListener('input', () => {
        submit.disabled = input.value.length === 0;
      });

      submit.addEventListener('click', async () => {
        submit.disabled = true;
        status.textContent = 'Checking…';

        try {
          const result = await PresenceApp._respond({ ...challenge, value: input.value });
          PresenceApp._handleResponse(result);
        } catch (err) {
          status.textContent = 'Failed to submit. Please try again.';
          submit.disabled = false;
        }
      });

      setTimeout(() => input.focus(), 300);
    },

    // ── VIDEO ───────────────────────────────────────────────────────────────

    /**
     * VIDEO: user records themselves saying challenge.value, max 5 seconds.
     *
     * Flow:
     *   1. Open front camera, display the phrase from challenge.value
     *   2. User taps Start — countdown begins (5, 4, 3, 2, 1)
     *   3. Recording stops automatically at 0 — no manual stop needed
     *   4. Clip is converted to base64 and POSTed immediately
     *
     * MediaRecorder collects chunks into an array, assembled into a Blob on stop.
     * video/webm is the most widely supported format across mobile browsers.
     */
    async VIDEO(challenge) {
      const panel      = document.getElementById('challenge-VIDEO');
      const video      = document.getElementById('video-preview');
      const recordBtn  = document.getElementById('video-record-btn');
      const countdown  = document.getElementById('video-countdown');
      const status     = document.getElementById('video-status');

      // Show the phrase the user needs to say.
      document.getElementById('video-phrase').textContent = challenge.value || '';

      panel.classList.remove('hidden');

      // Start (or restart) the camera stream and begin recording.
      // Extracted as a function so retry can call it again after a failed upload.
      async function startCamera() {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user' },
            audio: true,
          });
          video.srcObject = stream;
        } catch (err) {
          status.textContent = 'Camera permission denied. Please allow access and reload.';
          recordBtn.disabled = true;
        }
      }

      await startCamera();

      recordBtn.addEventListener('click', async () => {
        // On retry the stream will have been stopped — restart it before recording.
        if (!video.srcObject || video.srcObject.getTracks().every(t => t.readyState === 'ended')) {
          await startCamera();
        }

        recordBtn.disabled = true;
        recordBtn.textContent = 'Recording…';
        status.textContent = '';

        const chunks = [];
        const mediaRecorder = new MediaRecorder(video.srcObject);

        mediaRecorder.ondataavailable = e => {
          if (e.data.size > 0) chunks.push(e.data);
        };

        mediaRecorder.onstop = async () => {
          countdown.classList.add('hidden');
          status.textContent = 'Uploading…';

          // Stop the camera stream before the network call.
          video.srcObject.getTracks().forEach(t => t.stop());

          const blob = new Blob(chunks, { type: 'video/webm' });

          // Convert Blob to base64 via FileReader.
          const videoData = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload  = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });

          try {
            const result = await PresenceApp._respond({ ...challenge, videoData });
            PresenceApp._handleResponse(result);
          } catch (err) {
            status.textContent = 'Failed to upload. Please try again.';
            recordBtn.textContent = 'Try again';
            recordBtn.disabled = false;
          }
        };

        mediaRecorder.start();

        // Countdown: 5 → 4 → 3 → 2 → 1, then stop.
        const DURATION = 5;
        let remaining = DURATION;

        countdown.textContent = remaining;
        countdown.classList.remove('hidden');

        const tick = setInterval(() => {
          remaining--;
          countdown.textContent = remaining;

          if (remaining <= 0) {
            clearInterval(tick);
            mediaRecorder.stop();
          }
        }, 1000);
      });
    },

    // ── ENROL ───────────────────────────────────────────────────────────────

    /**
     * ENROL: dynamic form built from challenge.fields[].
     *
     * Each field descriptor:
     *   { name, label, type: "text"|"email"|"tel"|"number"|"date", required }
     *
     * Collects values, validates required fields, and POSTs as
     * { ...challenge, data: { fieldName: value, ... } } to /enrol.
     */
    ENROL(challenge) {
      const panel   = document.getElementById('challenge-ENROL');
      const fields  = document.getElementById('enrol-fields');
      const submit  = document.getElementById('enrol-submit');
      const status  = document.getElementById('enrol-status');

      panel.classList.remove('hidden');

      // Build form fields from the challenge descriptor.
      fields.innerHTML = (challenge.fields || []).map(field => `
        <div class="flex flex-col gap-1.5">
          <label for="enrol-${field.name}"
            class="text-sm font-medium text-gray-700">
            ${field.label}${field.required ? ' <span class="text-red-500">*</span>' : ''}
          </label>
          <input
            id="enrol-${field.name}"
            name="${field.name}"
            type="${field.type || 'text'}"
            ${field.required ? 'required' : ''}
            autocomplete="${field.type === 'email' ? 'email' : field.name}"
            class="w-full py-3.5 px-4 border-2 border-gray-200 rounded-2xl
                   text-base outline-none focus:border-blue-500 transition-colors" />
        </div>
      `).join('');

      submit.addEventListener('click', async () => {
        // Collect and validate.
        const data = {};
        let valid = true;

        for (const field of (challenge.fields || [])) {
          const el = document.getElementById(`enrol-${field.name}`);
          const val = el ? el.value.trim() : '';
          if (field.required && !val) {
            el.classList.add('border-red-500');
            valid = false;
          } else {
            el.classList.remove('border-red-500');
            data[field.name] = val;
          }
        }

        if (!valid) {
          status.textContent = 'Please fill in all required fields.';
          return;
        }

        submit.disabled = true;
        status.textContent = 'Submitting…';

        try {
          const result = await PresenceApp._respond({ ...challenge, data });
          PresenceApp._handleResponse(result);

        } catch (err) {
          status.textContent = 'Failed to submit. Please try again.';
          submit.disabled = false;
        }
      });
    },

  }, // /_challengeHandlers

  // ─── UI state machine ──────────────────────────────────────────────────────

  /**
   * Show one named state, hide all others.
   *
   * States: loading | error | used | window | challenge | complete | failed
   *
   * Keeping a single source of truth for visibility prevents states bleeding
   * into each other when the challenge chain advances quickly.
   */
  _showState(name, errorMessage) {
    const states = ['loading', 'error', 'used', 'window', 'challenge', 'complete', 'failed'];

    states.forEach(s => {
      const el = document.getElementById(`state-${s}`);
      if (el) el.classList.toggle('hidden', s !== name);
    });

    if (name === 'error' && errorMessage) {
      document.getElementById('error-message').textContent = errorMessage;
    }
  },

};

// ─── Boot ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => PresenceApp.init());
