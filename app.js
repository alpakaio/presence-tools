/**
 * presence.tools — Terminal
 * =========================
 * Reference implementation of the session terminal.
 * Determines its boot sequence from the URL path, then walks the challenge
 * chain until the server returns complete or failed.
 *
 * Architecture: one plain JS object (PresenceApp) with no framework, no
 * bundler, no build step. Every method is documented so you can lift
 * individual pieces into your own stack.
 *
 * URL patterns:
 *   /events/{eventId}/sessions/{sessionId}  — closed event, session pre-exists
 *   /events/{eventId}                       — open event, mint a session on arrival
 *
 * Flow (closed):
 *   init() → _fetchSession() → _showSession() → _runChallenge() → _respond()
 *                                                      ↑________________|
 * Flow (open):
 *   init() → _mintSession() → _showSession() → _runChallenge() → _respond()
 *                                                      ↑________________|
 *
 * After boot both flows are identical. All challenge POSTs go to the same
 * endpoint: POST /events/{eventId}/sessions/{sessionId}
 * The server always returns the full session object — _session stays current.
 */

const PresenceApp = {

  // ─── Configuration ────────────────────────────────────────────────────────

  /**
   * Resolve the API base URL from the current hostname.
   *
   * Dev:  file://, localhost, or *.dev.*  → api.dev.presence.tools
   * Prod: app.presence.tools              → api.presence.tools
   *
   * The same static bundle works in both environments — no build needed.
   */
  get apiBase() {
    const isFile      = window.location.protocol === 'file:';
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    return (isFile || isLocalhost || window.location.hostname.includes('.dev.'))
      ? 'https://api.dev.presence.tools'
      : 'https://api.presence.tools';
  },

  // ─── State ─────────────────────────────────────────────────────────────────

  /** eventId extracted from the URL — present for both open and closed events. */
  _eventId: null,

  /** sessionId — in the URL for closed events, returned by the server for open events. */
  _sessionId: null,

  /** AbortController for the currently active challenge's event listeners. */
  _challengeAc: null,

  /**
   * The full session object. Kept current after every server response —
   * the server returns the full session on every challenge POST so we
   * never have a stale local copy.
   */
  _session: null,

  /**
   * Index into session.challenges — the first challenge where passed is not true.
   * Derived from the session after each server response rather than incremented
   * locally, so the server is always the source of truth on what's been accepted.
   */
  _challengeIndex: 0,

  // ─── Entry point ───────────────────────────────────────────────────────────

  async init() {
    this._parsePath();

    if (!this._eventId) {
      this._showState('error', 'No event found in the URL.');
      return;
    }

    try {
      if (this._sessionId) {
        // Closed event — session was pre-created for a known identity.
        this._session = await this._fetchSession();
      } else {
        // Open event — mint a fresh session on arrival, store the returned sessionId.
        this._session    = await this._mintSession();
        this._sessionId  = this._session.sessionId;
      }
      this._showSession();
    } catch (err) {
      console.error('[PresenceApp] Failed to load session:', err);
      this._showState('error', err.message || 'Could not load session. Please try again.');
    }
  },

  // ─── URL parsing ───────────────────────────────────────────────────────────

  /**
   * Extract eventId and sessionId from the URL path.
   *
   * /events/{eventId}/sessions/{sessionId}  → closed event
   * /events/{eventId}                       → open event
   *
   * Query param fallback for local dev:
   *   ?eventId=...&sessionId=...
   */
  _parsePath() {
    const isFile = window.location.protocol === 'file:';
    const params = new URLSearchParams(window.location.search);
    const parts  = window.location.pathname.replace(/^\//, '').split('/');

    if (!isFile && parts[0] === 'events' && parts[1]) {
      this._eventId   = parts[1];
      this._sessionId = (parts[2] === 'sessions' && parts[3]) ? parts[3] : null;
    } else {
      this._eventId   = params.get('eventId')   || null;
      this._sessionId = params.get('sessionId') || null;
    }
  },

  // ─── Session loading ───────────────────────────────────────────────────────

  /**
   * GET /events/{eventId}/sessions/{sessionId}
   * Fetches a pre-existing session for a closed event.
   * Also used by _pollSession to check async challenge (CALL) status.
   */
  async _fetchSession() {
    const res = await fetch(
      `${this.apiBase}/events/${this._eventId}/sessions/${this._sessionId}`
    );
    if (res.status === 404) throw new Error('Session not found or expired.');
    if (!res.ok)            throw new Error(`Server error (${res.status})`);
    return res.json();
  },

  /**
   * POST /events/{eventId}/sessions
   * Mints a fresh session for an open event.
   * POST because this creates a record server-side even though no body is sent.
   * Returns the full session object including the new sessionId.
   */
  async _mintSession() {
    const res = await fetch(
      `${this.apiBase}/events/${this._eventId}/sessions`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } }
    );
    if (res.status === 404) throw new Error('Event not found or expired.');
    if (res.status === 410) throw new Error('This event is no longer active.');
    if (!res.ok)            throw new Error(`Server error (${res.status})`);
    return res.json();
  },

  // ─── Session display ───────────────────────────────────────────────────────

  /**
   * Inspect the loaded session and decide what to show.
   *
   * Decision tree:
   *  1. session.used      → already completed, show used screen
   *  2. outside window    → too early or too late
   *  3. otherwise         → apply branding, start challenge chain
   */
  _showSession() {
    const session = this._session;

    this._applyBranding(session);

    if (session.expired) {
      this._showState('used');
      return;
    }

    const windowState = this._getWindowState(session.locations);
    if (windowState !== 'open') {
      this._showWindowState(windowState, session.locations);
      return;
    }

    this._challengeIndex = this._nextChallengeIndex();
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
   *   'open'  — at least one window is currently open
   *   'early' — all windows are in the future
   *   'late'  — all windows have closed
   *
   * The terminal doesn't enforce this — the server rejects out-of-window
   * submissions anyway. We check here to give a friendlier early message.
   */
  _getWindowState(locations) {
    if (!locations || locations.length === 0) return 'open';

    const now = Date.now();
    let anyFuture = false;
    let anyPast   = false;

    for (const loc of locations) {
      if (!loc.window) continue;

      const opens  = new Date(loc.window.opens_at).getTime();
      const closes = new Date(loc.window.closes_at).getTime();

      if (now >= opens && now <= closes) return 'open';
      if (now < opens)  anyFuture = true;
      if (now > closes) anyPast   = true;
    }

    if (anyFuture && !anyPast) return 'early';
    if (anyPast)               return 'late';
    return 'open';
  },

  _showWindowState(state, locations) {
    document.getElementById('window-heading').textContent =
      state === 'early' ? 'You\'re a little early' : 'This session has closed';

    const times = (locations || [])
      .filter(l => l.window)
      .map(l => ({ opens: new Date(l.window.opens_at), closes: new Date(l.window.closes_at) }));

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
   * Challenges come from session.challenges[] in order. _challengeIndex
   * tracks position. Each call renders one challenge and wires up its
   * submit handler. When the server returns { status: "next" }, we
   * increment and call again — this is the loop.
   */
  _runChallenge(retryMessage) {
    const challenges = this._session.challenges;
    const challenge  = challenges[this._challengeIndex];

    if (!challenge) {
      this._showState('complete');
      return;
    }

    this._updateProgress(this._challengeIndex, challenges.length);
    this._showState('challenge');

    const handler = this._challengeHandlers[challenge.type];

    if (!handler) {
      this._showState('error', `Unknown challenge type: "${challenge.type}". Is your terminal up to date?`);
      return;
    }

    // Abort any listeners from the previous challenge before mounting the next.
    if (this._challengeAc) this._challengeAc.abort();
    this._challengeAc = new AbortController();

    document.querySelectorAll('[id^="challenge-"]').forEach(el => el.classList.add('hidden'));
    handler.call(this, challenge, this._challengeAc.signal, retryMessage);
  },

  /**
   * Find the index of the first challenge not yet passed, or whose pass is
   * stale (completedAt > 5 minutes ago in UTC). Both Date.now() and ISO
   * completedAt strings from the server are UTC, so the comparison is exact.
   * Used on boot to resume a session; mid-session the server drives advancement.
   */
  _nextChallengeIndex() {
    const challenges    = this._session.challenges || [];
    const fiveMinAgoUtc = Date.now() - 5 * 60 * 1000;
    const idx = challenges.findIndex(c => {
      if (!c.passed) return true;
      if (!c.completedAt) return true;
      return new Date(c.completedAt).getTime() < fiveMinAgoUtc;
    });
    return idx === -1 ? challenges.length : idx;
  },

  _updateProgress(index, total) {
    const step = index + 1;
    document.getElementById('progress-bar-fill').style.width = `${(step / total) * 100}%`;
    document.getElementById('progress-label').textContent    = `${step} of ${total}`;
  },

  // ─── API ───────────────────────────────────────────────────────────────────

  /**
   * POST /events/{eventId}/sessions/{sessionId}
   *
   * Body is an array of challenge objects. Normally one entry, but if a GEO
   * challenge preceded this one in the chain a second entry is appended:
   *   [
   *     { type: "FACE", imageData: "..." },
   *     { type: "GEO",  lat: 51.5, lng: -0.1 }
   *   ]
   *
   * The server always returns the full session object. _session is updated
   * from every response so it never goes stale.
   */
  async _respond(challenge) {
    const body = [challenge];

    const res = await fetch(
      `${this.apiBase}/events/${this._eventId}/sessions/${this._sessionId}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      }
    );

    const data = await res.json();
    if (!res.ok && !data.status) throw new Error(`Server error (${res.status})`);
    return data;
  },

  /**
   * Handle the server's response after a challenge submission.
   *
   * The server always returns the full session object — we update _session
   * first so any subsequent calls have fresh data.
   *
   *   next     → advance to next challenge
   *   pending  → async challenge in progress (CALL) — poll until resolved
   *   complete → all challenges passed
   *   failed   → challenge rejected
   */
  _handleResponse(result) {
    // Keep local session fresh from every server response.
    this._session = result;

    if (result.status === 'next') {
      this._challengeIndex = this._nextChallengeIndex();
      this._runChallenge();

    } else if (result.status === 'pending') {
      // CALL is async — the server resolves it when the call completes.
      // Poll by re-fetching the session every 5 seconds.
      setTimeout(() => this._pollSession(), 5000);

    } else if (result.status === 'complete') {
      if (result.confidence != null) {
        const conf = document.getElementById('complete-confidence');
        conf.textContent = `Confidence: ${Math.round(result.confidence * 100)}%`;
        conf.classList.remove('hidden');
      }
      this._showState('complete');

    } else if (result.status === 'failed') {
      // Derive reason from the failed challenge if the server doesn't send one.
      const failedChallenge = (result.challenges || []).find(c => c.passed === false);
      const inferredReason  = result.reason || (failedChallenge && {
        PIN:      'PIN_INCORRECT',
        PASSWORD: 'PASSWORD_WRONG',
        FACE:     'FACE_NOT_FOUND',
        SMS:      'OTP_INCORRECT',
        EMAIL:    'OTP_INCORRECT',
        GEO:      'GEO_TOO_FAR',
        CALL:     'CALL_NOT_VERIFIED',
      }[failedChallenge.type]);

      const messages = {
        PIN_INCORRECT:     'Incorrect PIN. Please try again.',
        FACE_NOT_FOUND:    'We couldn\'t match your face. Please try again.',
        FACE_LOW_CONF:     'Face match confidence too low. Try again in better lighting.',
        OTP_INCORRECT:     'Incorrect code. Please check and try again.',
        OTP_EXPIRED:       'That code has expired. Please request a new one.',
        PASSWORD_WRONG:    'Incorrect password. Please try again.',
        GEO_TOO_FAR:       'You\'re not in the right location for this event.',
        CALL_NOT_VERIFIED: 'We couldn\'t verify the call. Please try again.',
      };
      const message = messages[inferredReason] || `Verification failed (${inferredReason || 'unknown'}).`;

      const retryable = ['PIN_INCORRECT', 'FACE_NOT_FOUND', 'FACE_LOW_CONF',
                         'OTP_INCORRECT', 'OTP_EXPIRED', 'PASSWORD_WRONG'];
      if (retryable.includes(inferredReason)) {
        this._runChallenge(message);
      } else {
        document.getElementById('failed-message').textContent = message;
        this._showState('failed');
      }

    } else {
      this._showState('error', 'Unexpected response from server.');
    }
  },

  /**
   * Poll the session until an async challenge resolves.
   * Used by CALL — the server updates session.status to "next" or "failed"
   * when the call outcome is known. We re-use _handleResponse to route it.
   */
  async _pollSession() {
    try {
      const result = await this._fetchSession();
      this._handleResponse(result);
    } catch (err) {
      console.warn('[PresenceApp] Poll failed:', err);
      // Retry after 5s — network blip shouldn't abort a CALL in progress.
      setTimeout(() => this._pollSession(), 5000);
    }
  },

  // ─── Challenge handlers ────────────────────────────────────────────────────

  /**
   * Each handler receives the challenge object from session.challenges[].
   * Responsibilities:
   *   1. Show the right #challenge-X panel
   *   2. Collect input from the user
   *   3. Call _respond() with the challenge + captured value
   *   4. Call _handleResponse() with the result
   */
  _challengeHandlers: {

    // ── GEO ────────────────────────────────────────────────────────────────

    /**
     * GEO: request location, show a waiting screen, POST coords on success.
     * On denial or timeout: show an error with a retry button.
     */
    GEO(challenge, signal) {
      const panel    = document.getElementById('challenge-GEO');
      const spinner  = document.getElementById('geo-spinner');
      const status   = document.getElementById('geo-status');
      const retryBtn = document.getElementById('geo-retry-btn');

      panel.classList.remove('hidden');

      function attempt() {
        spinner.classList.remove('hidden');
        retryBtn.classList.add('hidden');
        status.textContent = 'Allow location access when prompted.';

        navigator.geolocation.getCurrentPosition(
          async pos => {
            status.textContent = 'Got it, submitting...';
            try {
              const result = await PresenceApp._respond({
                type: 'GEO',
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
              });
              PresenceApp._handleResponse(result);
            } catch (err) {
              status.textContent = 'Failed to submit location. Please try again.';
              spinner.classList.add('hidden');
              retryBtn.classList.remove('hidden');
            }
          },
          err => {
            spinner.classList.add('hidden');
            if (err.code === 1) {
              status.textContent = 'Location access was denied. Please enable it in your browser settings and try again.';
            } else if (err.code === 3) {
              status.textContent = 'Location request timed out. Please try again.';
            } else {
              status.textContent = 'Could not get your location. Please try again.';
            }
            retryBtn.classList.remove('hidden');
          },
          { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
        );
      }

      retryBtn.addEventListener('click', attempt, { signal });
      attempt();
    },

    // ── FACE ───────────────────────────────────────────────────────────────

    /**
     * FACE: open the front camera, capture a JPEG frame, submit as base64.
     *
     * facingMode: "user" requests the selfie camera.
     * Canvas captures one frame from the live video stream.
     * quality: 0.85 balances payload size vs. Rekognition accuracy.
     * Camera stream is stopped before the network call to free hardware.
     */
    async FACE(challenge, signal, retryMessage) {
      const panel  = document.getElementById('challenge-FACE');
      const video  = document.getElementById('face-preview');
      const canvas = document.getElementById('face-canvas');
      const btn    = document.getElementById('face-btn');
      const status = document.getElementById('face-status');

      panel.classList.remove('hidden');
      btn.disabled       = false;
      status.textContent = retryMessage || '';
      status.classList.toggle('text-red-500', !!retryMessage);

      try {
        video.srcObject = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user' },
          audio: false,
        });
      } catch (err) {
        status.textContent = 'Camera permission denied. Please allow access and reload.';
        btn.disabled = true;
        return;
      }

      btn.addEventListener('click', async () => {
        btn.disabled = true;
        status.textContent = 'Capturing…';

        const size   = Math.min(video.videoWidth, video.videoHeight);
        const cropX  = Math.floor((video.videoWidth - size) / 2);
        const cropY  = Math.floor((video.videoHeight - size) / 2);
        canvas.width  = size;
        canvas.height = size;
        canvas.getContext('2d').drawImage(video, cropX, cropY, size, size, 0, 0, size, size);

        const imageData = canvas.toDataURL('image/jpeg', 0.85);

        video.srcObject.getTracks().forEach(t => t.stop());
        status.textContent = 'Submitting…';

        try {
          const result = await PresenceApp._respond({ ...challenge, imageData });
          PresenceApp._handleResponse(result);
        } catch (err) {
          status.textContent = 'Failed to submit photo. Please try again.';
          btn.disabled = false;
        }
      }, { signal });
    },

    // ── PIN ────────────────────────────────────────────────────────────────

    /**
     * PIN: custom PIN pad — no OS keyboard appears.
     *
     * Dot display grows as digits are entered: always one empty dot ahead
     * so the required length is never revealed to the user.
     * Server determines the required length — we don't enforce it client-side.
     */
    PIN(challenge, signal, retryMessage) {
      const panel   = document.getElementById('challenge-PIN');
      const display = document.getElementById('pin-display');
      const submit  = document.getElementById('pin-submit');
      const back    = document.getElementById('pin-back');
      const status  = document.getElementById('pin-status');

      panel.classList.remove('hidden');
      status.textContent = retryMessage || '';
      status.classList.toggle('text-red-500', !!retryMessage);

      let pin = '';

      function updateDisplay() {
        const total = pin.length + 1;
        display.innerHTML = Array.from({ length: total }, (_, i) =>
          `<div class="w-3.5 h-3.5 rounded-full border-2 ${
            i < pin.length ? 'bg-gray-900 border-gray-900' : 'border-gray-300'
          }"></div>`
        ).join('');
        submit.disabled = pin.length === 0;
      }

      updateDisplay();

      document.querySelectorAll('.pin-key').forEach(key => {
        if (key === back) return;
        key.addEventListener('click', () => {
          if (pin.length >= 8) return;
          pin += key.textContent;
          updateDisplay();
        }, { signal });
      });

      back.addEventListener('click', () => {
        pin = pin.slice(0, -1);
        updateDisplay();
      }, { signal });

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
      }, { signal });
    },

    // ── SMS ────────────────────────────────────────────────────────────────

    /**
     * SMS: server sends a 4-digit OTP to the identity's phone number.
     * Terminal shows 4 individual digit boxes.
     * autocomplete="one-time-code" on the first box triggers iOS/Android
     * SMS autofill — the OS fills all four digits from the notification.
     */
    SMS(challenge, signal, retryMessage) {
      document.getElementById('otp-heading').textContent = 'Check your texts';
      document.getElementById('otp-subheading').innerHTML =
        'We\'ve sent a verification code by SMS.<br>Enter it below.';
      PresenceApp._challengeHandlers._OTP.call(this, challenge, signal, retryMessage);
    },

    // ── EMAIL ──────────────────────────────────────────────────────────────

    EMAIL(challenge, signal, retryMessage) {
      document.getElementById('otp-heading').textContent = 'Check your email';
      document.getElementById('otp-subheading').innerHTML =
        'We\'ve sent a verification code to your email address.<br>Enter it below.';
      PresenceApp._challengeHandlers._OTP.call(this, challenge, signal, retryMessage);
    },

    /**
     * Shared OTP handler for SMS and EMAIL.
     *
     * 4 individual digit boxes — typing auto-advances focus, backspace moves back.
     * Paste handling splits a full code across all boxes (iOS SMS autofill
     * pastes the whole string into the first box).
     */
    _OTP(challenge, signal, retryMessage) {
      const panel  = document.getElementById('challenge-OTP');
      const boxes  = Array.from(document.querySelectorAll('.otp-box'));
      const submit = document.getElementById('otp-submit');
      const status = document.getElementById('otp-status');

      panel.classList.remove('hidden');

      boxes.forEach(b => b.value = '');
      submit.disabled    = true;
      status.textContent = retryMessage || '';
      status.classList.toggle('text-red-500', !!retryMessage);

      function currentCode() { return boxes.map(b => b.value).join(''); }

      boxes.forEach((box, i) => {
        box.addEventListener('input', () => {
          box.value = box.value.replace(/\D/g, '').slice(-1);
          if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
          submit.disabled = currentCode().length < boxes.length;
        }, { signal });

        box.addEventListener('keydown', e => {
          if (e.key === 'Backspace' && !box.value && i > 0) boxes[i - 1].focus();
        }, { signal });

        // iOS pastes the full OTP into the first box — split it across all boxes.
        box.addEventListener('paste', e => {
          const pasted = (e.clipboardData || window.clipboardData)
            .getData('text').replace(/\D/g, '');
          if (pasted.length >= boxes.length) {
            e.preventDefault();
            boxes.forEach((b, j) => b.value = pasted[j] || '');
            submit.disabled = currentCode().length < boxes.length;
            boxes[boxes.length - 1].focus();
          }
        }, { signal });
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
      }, { signal });

      setTimeout(() => boxes[0].focus(), 300);
    },

    // ── CALL ───────────────────────────────────────────────────────────────

    /**
     * CALL: server initiates a voice call. challenge.value is a passphrase
     * the user reads aloud when prompted.
     *
     * The terminal POSTs once to register the challenge, then _handleResponse
     * routes the "pending" status to _pollSession which polls GET /sessions
     * every 5 seconds until the server returns "next" or "failed".
     *
     * A retry button appears if the user wants to trigger another call attempt.
     */
    async CALL(challenge, signal) {
      const panel  = document.getElementById('challenge-CALL');
      const status = document.getElementById('call-status');
      const retry  = document.getElementById('call-retry');

      document.getElementById('call-passphrase').textContent = challenge.value || '';
      panel.classList.remove('hidden');
      status.textContent = 'Waiting for the call to complete…';

      // POST once — server initiates the call and returns { status: "pending" }.
      // _handleResponse takes over from here and starts polling via _pollSession.
      try {
        const result = await PresenceApp._respond({ ...challenge });
        PresenceApp._handleResponse(result);
      } catch (err) {
        status.textContent = 'Failed to initiate call. Please try again.';
        retry.classList.remove('hidden');
      }

      retry.addEventListener('click', async () => {
        retry.classList.add('hidden');
        status.textContent = 'Waiting for the call to complete…';
        try {
          const result = await PresenceApp._respond({ ...challenge });
          PresenceApp._handleResponse(result);
        } catch (err) {
          status.textContent = 'Failed to initiate call. Please try again.';
          retry.classList.remove('hidden');
        }
      }, { signal });
    },

    // ── PASSWORD ───────────────────────────────────────────────────────────

    PASSWORD(challenge, signal, retryMessage) {
      const panel    = document.getElementById('challenge-PASSWORD');
      const input    = document.getElementById('password-input');
      const submit   = document.getElementById('password-submit');
      const status   = document.getElementById('password-status');
      const toggle   = document.getElementById('password-toggle');
      const eyeShow  = document.getElementById('password-eye-show');
      const eyeHide  = document.getElementById('password-eye-hide');

      panel.classList.remove('hidden');

      input.value        = '';
      input.type         = 'password';
      eyeShow.classList.remove('hidden');
      eyeHide.classList.add('hidden');
      submit.disabled    = true;
      status.textContent = retryMessage || '';
      status.classList.toggle('text-red-500', !!retryMessage);

      toggle.addEventListener('click', () => {
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        eyeShow.classList.toggle('hidden', isPassword);
        eyeHide.classList.toggle('hidden', !isPassword);
      }, { signal });

      input.addEventListener('input', () => {
        submit.disabled = input.value.length === 0;
      }, { signal });

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
      }, { signal });

      setTimeout(() => input.focus(), 300);
    },

    // ── VIDEO ───────────────────────────────────────────────────────────────

    /**
     * VIDEO: user records themselves saying challenge.value, ~8 seconds.
     *
     * Flow:
     *   1. GET /video/challenge to fetch a token (60s expiry)
     *   2. Display the phrase and Start button
     *   3. On tap — capture a still frame from the live preview, start recording
     *   4. Countdown 8→1, auto-stop
     *   5. POST { type, frame, video, token }
     *
     * Nonce expires in 60 seconds. A 55s timer re-fetches it and resets the UI
     * so the user always has a fresh token ready when they tap Start.
     */
    async VIDEO(challenge, signal) {
      const panel         = document.getElementById('challenge-VIDEO');
      const video         = document.getElementById('video-preview');
      const recordBtn     = document.getElementById('video-record-btn');
      const restartBtn    = document.getElementById('video-restart-btn');
      const countdown     = document.getElementById('video-countdown');
      const countdownSecs = document.getElementById('video-countdown-seconds');
      const status        = document.getElementById('video-status');
      const audioLevel    = document.getElementById('video-audio-level');

      document.getElementById('video-phrase').textContent = challenge.value || '';
      panel.classList.remove('hidden');

      let audioCtx      = null;
      let levelRafId    = null;

      function startAudioMeter(stream) {
        audioCtx = new AudioContext();
        const source   = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const buf = new Uint8Array(analyser.frequencyBinCount);
        function tick() {
          analyser.getByteFrequencyData(buf);
          const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
          audioLevel.style.width = `${Math.min(avg * 2, 100)}%`;
          levelRafId = requestAnimationFrame(tick);
        }
        tick();
      }

      function stopAudioMeter() {
        cancelAnimationFrame(levelRafId);
        if (audioCtx) { audioCtx.close(); audioCtx = null; }
        audioLevel.style.width = '0%';
      }

      signal.addEventListener('abort', stopAudioMeter, { once: true });

      async function startCamera() {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user' },
            audio: true,
          });
          video.srcObject = stream;
          startAudioMeter(stream);
        } catch (err) {
          if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
            status.textContent = 'No microphone found. Please connect a microphone and try again.';
          } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
            status.textContent = 'Microphone is in use or unavailable. Please check your audio device.';
          } else {
            status.textContent = 'Camera or microphone permission denied. Please allow access and reload.';
          }
          recordBtn.disabled = true;
        }
      }

      async function fetchNonce() {
        const res = await fetch(
          `${PresenceApp.apiBase}/events/${PresenceApp._eventId}/sessions/${PresenceApp._sessionId}/video/challenge`
        );
        if (!res.ok) throw new Error(`Could not fetch video token (${res.status})`);
        const data = await res.json();
        return data.token;
      }

      function captureFrame() {
        const canvas = document.createElement('canvas');
        canvas.width  = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        return canvas.toDataURL('image/jpeg', 0.85);
      }

      await startCamera();

      let currentToken = null;
      let tokenTimer   = null;

      async function refreshNonce() {
        clearTimeout(tokenTimer);
        try {
          currentToken = await fetchNonce();
          // Re-fetch 5s before expiry so Start always has a fresh token.
          tokenTimer = setTimeout(refreshNonce, 55000);
          signal.addEventListener('abort', () => clearTimeout(tokenTimer), { once: true });
        } catch (err) {
          status.textContent = 'Could not prepare challenge. Please try again.';
          recordBtn.disabled = true;
        }
      }

      await refreshNonce();

      let activeRecording = null;

      function stopActive() {
        if (!activeRecording) return;
        clearInterval(activeRecording.tick);
        activeRecording.mediaRecorder.ondataavailable = null;
        activeRecording.mediaRecorder.onstop = null;
        try { activeRecording.mediaRecorder.stop(); } catch (_) {}
        activeRecording = null;
      }

      function resetUI() {
        countdown.classList.add('hidden');
        restartBtn.classList.add('hidden');
        recordBtn.classList.remove('hidden');
        recordBtn.disabled = false;
        recordBtn.textContent = 'Start recording';
        status.textContent = '';
      }

      restartBtn.addEventListener('click', async () => {
        stopActive();
        if (!video.srcObject || video.srcObject.getTracks().every(t => t.readyState === 'ended')) {
          await startCamera();
        }
        await refreshNonce();
        resetUI();
      }, { signal });

      recordBtn.addEventListener('click', async () => {
        if (!video.srcObject || video.srcObject.getTracks().every(t => t.readyState === 'ended')) {
          await startCamera();
        }

        // Capture the frame before recording starts — camera is already live.
        const frame = captureFrame();

        // Freeze the token we'll submit with — refreshNonce won't overwrite mid-recording.
        const token = currentToken;
        clearTimeout(tokenTimer);

        recordBtn.classList.add('hidden');
        restartBtn.classList.remove('hidden');
        status.textContent = '';

        const chunks = [];
        const mediaRecorder = new MediaRecorder(video.srcObject);

        mediaRecorder.ondataavailable = e => {
          if (e.data.size > 0) chunks.push(e.data);
        };

        mediaRecorder.onstop = async () => {
          // onstop fires on both natural end and restart — only upload on natural end.
          if (activeRecording) return;

          countdown.classList.add('hidden');
          restartBtn.classList.add('hidden');
          status.textContent = 'Uploading…';

          video.srcObject.getTracks().forEach(t => t.stop());

          const blob = new Blob(chunks, { type: 'video/webm' });
          const videoB64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload  = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });

          try {
            const result = await PresenceApp._respond({ ...challenge, frame, video: videoB64, token });
            PresenceApp._handleResponse(result);
          } catch (err) {
            status.textContent = 'Failed to upload. Please try again.';
            await startCamera();
            await refreshNonce();
            resetUI();
          }
        };

        mediaRecorder.start();

        const DURATION = 5;
        let remaining = DURATION;
        countdownSecs.textContent = remaining;
        countdown.classList.remove('hidden');

        const tick = setInterval(() => {
          remaining--;
          countdownSecs.textContent = remaining;
          if (remaining <= 0) {
            clearInterval(tick);
            activeRecording = null;
            mediaRecorder.stop();
          }
        }, 1000);

        activeRecording = { mediaRecorder, tick };
      }, { signal });
    },

    // ── ENROL ───────────────────────────────────────────────────────────────

    /**
     * ENROL: dynamic form built from challenge.fields[].
     *
     * Field descriptor: { name, label, type: "text"|"email"|"tel"|"number"|"date", required }
     *
     * When a session has no identityId and ENROL is first in the chain,
     * the server creates a new identity from the submitted fields and returns
     * its identityId. Every subsequent challenge becomes a setter — PIN sets
     * their PIN, FACE indexes their photo — rather than verifying pre-existing data.
     * This is how self-registration flows work.
     */
    ENROL(challenge, signal) {
      const panel  = document.getElementById('challenge-ENROL');
      const fields = document.getElementById('enrol-fields');
      const submit = document.getElementById('enrol-submit');
      const status = document.getElementById('enrol-status');

      panel.classList.remove('hidden');

      fields.innerHTML = (challenge.fields || []).map(field => `
        <div class="flex flex-col gap-1.5">
          <label for="enrol-${field.name}" class="text-sm font-medium text-gray-700">
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
        const data = {};
        let valid = true;

        for (const field of (challenge.fields || [])) {
          const el  = document.getElementById(`enrol-${field.name}`);
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
      }, { signal });
    },

  }, // /_challengeHandlers

  // ─── UI state machine ──────────────────────────────────────────────────────

  /**
   * Show one named state, hide all others.
   * States: loading | error | used | window | challenge | complete | failed
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
