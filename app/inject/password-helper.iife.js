;(() => {
  // Password remember / autofill helper.
  // Uses bfAppBridge.credsSave/credsLoad (keytar) and bfAppBridge.storage* (electron-store).

  if (window.__BFAPP_SAVE_PW__) return;
  window.__BFAPP_SAVE_PW__ = true;

  const KEY_NEVER = (u) => `bfapp_pw_never:${String(u).toLowerCase()}`;
  const KEY_PROMPTED = (u) => `bfapp_pw_prompted:${String(u).toLowerCase()}`;
  const KEY_LAST_USER = 'bfapp_last_username';

  function findUsernameInput() {
    return document.querySelector(
      'input[autocomplete="username"], input[type="email"], input[type="text"], input[name*="user" i], input[id*="user" i], input[name*="email" i], input[id*="email" i]'
    );
  }

  function findPasswordInput() {
    return document.querySelector('input[type="password"], input[autocomplete="current-password"]');
  }

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function onPasswordStep() {
    const pass = findPasswordInput();
    return !!pass && isVisible(pass);
  }

  async function storageGet(key, fallback) {
    try {
      const res = await window.bfAppBridge?.storageGet?.([key]);
      return res && Object.prototype.hasOwnProperty.call(res, key) ? res[key] : fallback;
    } catch {
      return fallback;
    }
  }

  async function storageSet(obj) {
    try {
      await window.bfAppBridge?.storageSet?.(obj);
    } catch {}
  }

  function setNativeValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Remember last username so multi-step login flows can still autofill on the password step.
  async function rememberUsernameIfPresent() {
    const userEl = findUsernameInput();
    if (!userEl || !isVisible(userEl)) return;
    const u = (userEl.value || '').trim();
    if (!u) return;
    await storageSet({ [KEY_LAST_USER]: u });
  }

  async function getActiveUsername() {
    const userEl = findUsernameInput();
    const direct = userEl && isVisible(userEl) ? (userEl.value || '').trim() : '';
    if (direct) return direct;
    return (await storageGet(KEY_LAST_USER, '')) || '';
  }

  // Autofill when a password field is visible.
  let lastFillAt = 0;
  async function tryAutofillPassword() {
    if (!onPasswordStep()) return;

    const passEl = findPasswordInput();
    if (!passEl) return;
    if ((passEl.value || '').length > 0) return; // don't fight the user

    const username = await getActiveUsername();
    if (!username) return;

    const never = await storageGet(KEY_NEVER(username), false);
    if (never) return;

    const pwd = await window.bfAppBridge?.credsLoad?.(username);
    if (!pwd) return;

    const now = Date.now();
    if (now - lastFillAt < 600) return;
    lastFillAt = now;

    passEl.focus();
    setNativeValue(passEl, pwd);

    // If the site clears it instantly, refill once.
    setTimeout(() => {
      try {
        const still = findPasswordInput();
        if (!still) return;
        if ((still.value || '').length === 0) setNativeValue(still, pwd);
      } catch {}
    }, 250);
  }

  function showSavePopup(username, password) {
    if (document.getElementById('bfapp-savepw-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'bfapp-savepw-modal';
    modal.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    `;

    const card = document.createElement('div');
    card.style.cssText = `
      width: min(420px, 92vw);
      background: #111; color: #fff; border: 1px solid rgba(255,255,255,.12);
      border-radius: 14px; padding: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,.6);
    `;

    card.innerHTML = `
      <div style="font-size:15px;font-weight:700;margin-bottom:6px;">Save password?</div>
      <div style="font-size:13px;opacity:.9;line-height:1.35;margin-bottom:12px;">
        Save securely so next time it auto-fills and you just click Login.
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
        <button data-act="never" style="padding:8px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:transparent;color:#fff;cursor:pointer;">Never</button>
        <button data-act="later" style="padding:8px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:transparent;color:#fff;cursor:pointer;">Not now</button>
        <button data-act="save" style="padding:8px 12px;border-radius:10px;border:0;background:#2b6cff;color:#fff;cursor:pointer;font-weight:700;">Save</button>
      </div>
    `;

    modal.appendChild(card);
    document.documentElement.appendChild(modal);

    const close = () => {
      try { modal.remove(); } catch {}
    };

    modal.addEventListener('click', (e) => {
      try {
        if (e.target === modal) close();
      } catch {}
    });

    // ✅ IMPORTANT: DO NOT make this handler async
    // Use an async IIFE + catch to avoid triggering global "unhandledrejection" toasts.
    card.addEventListener('click', (e) => {
      const btn = e.target?.closest?.('button[data-act]');
      if (!btn) return;

      e.preventDefault?.();
      e.stopPropagation?.();

      const act = btn.getAttribute('data-act');

      void (async () => {
        if (act === 'save') {
          // ✅ Silent save: no toast, no error popups
          try {
            // Prefer current field value at click-time
            const passEl = findPasswordInput();
            let pw = String(passEl?.value || '');

            // Fallback to captured password (do NOT trim)
            if (!pw) pw = String(password || '');

            // Don't save obviously incomplete passwords
            if (!pw || pw.length < 6) { close(); return; }

            await window.bfAppBridge?.credsSave?.(username, pw);
            await storageSet({ [KEY_PROMPTED(username)]: true });
          } catch {
            // stay silent (no toast)
          }
          close();
          return;
        }

        if (act === 'never') {
          await storageSet({ [KEY_NEVER(username)]: true, [KEY_PROMPTED(username)]: true });
          close();
          return;
        }

        // "Not now" — do NOT set prompted, so it can ask again later.
        close();
      })().catch(() => {
        // swallow everything so your global error handler never fires a toast here
        try { close(); } catch {}
      });
    });
  }

  // Track a login attempt on the password step so we can prompt after the modal closes.
  let pending = null;

  function hookLoginAttempt() {
    if (window.__bfappHookedSavePwClicks) return;
    window.__bfappHookedSavePwClicks = true;

    const captureCreds = async () => {
      const passEl = findPasswordInput();
      if (!passEl) return;

      const username = await getActiveUsername();
      const p = String(passEl.value || ''); // don't trim passwords
      if (!username || !p) return;

      pending = { u: username, p, t: Date.now(), seenClosed: 0 };
    };

    document.addEventListener(
      'click',
      (e) => {
        if (!onPasswordStep()) return;
        const el = e.target?.closest?.('button, input[type="submit"]');
        if (!el) return;
        void captureCreds().catch(() => {});
      },
      true
    );

    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Enter') return;
        if (!onPasswordStep()) return;
        void captureCreds().catch(() => {});
      },
      true
    );
  }

  async function maybePromptAfterLogin() {
    if (!pending) return;
    if (Date.now() - pending.t > 120000) {
      pending = null;
      return;
    }

    const { u, p } = pending;

    const never = await storageGet(KEY_NEVER(u), false);
    if (never) {
      pending = null;
      return;
    }

    const prompted = await storageGet(KEY_PROMPTED(u), false);
    if (prompted) {
      pending = null;
      return;
    }

    // Wait until password step disappears (modal closes). Require 2 checks to avoid false positives.
    if (onPasswordStep()) return;
    pending.seenClosed += 1;
    if (pending.seenClosed < 2) return;

    showSavePopup(u, p);
    pending = null;
  }

  const mo = new MutationObserver(() => {
    void (async () => {
      await rememberUsernameIfPresent();
      hookLoginAttempt();
      await tryAutofillPassword();
      await maybePromptAfterLogin();
    })().catch(() => {});
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  setInterval(() => {
    void (async () => {
      await rememberUsernameIfPresent();
      hookLoginAttempt();
      await tryAutofillPassword();
      await maybePromptAfterLogin();
    })().catch(() => {});
  }, 1200);
})();
