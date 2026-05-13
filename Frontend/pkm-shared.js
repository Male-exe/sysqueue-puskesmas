/**
 * pkm-shared.js — Utilitas bersama semua halaman
 * UPTD Puskesmas Cangadi — Sistem Antrian
 *
 * Versi: 3.0 (diperbaiki untuk koneksi Vercel ↔ Railway)
 *
 * Include di setiap HTML:
 *   <script src="/pkm-shared.js"></script>
 */

/* ══════════════════════════════════════════════════
   CONFIG
   Gunakan environment variable VITE_API_URL (Vite)
   atau REACT_APP_API_URL / NEXT_PUBLIC_API_URL
   untuk production. Fallback ke URL Railway.
══════════════════════════════════════════════════ */
const API_BASE = (
  import.meta?.env?.VITE_API_URL ||
  (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_API_URL) ||
  (typeof process !== 'undefined' && process.env?.REACT_APP_API_URL) ||
  'https://backend-sysqueue.up.railway.app'
).replace(/\/$/, ''); // hapus trailing slash

const PKM = {
  BASE_URL: API_BASE,
  WS_URL: API_BASE.replace(/^http/, 'ws'), // http → ws, https → wss
};

console.log('[PKM] Backend URL:', PKM.BASE_URL);
console.log('[PKM] WebSocket URL:', PKM.WS_URL);

/* ══════════════════════════════════════════════════
   AUTH — Manajemen sesi JWT via localStorage
══════════════════════════════════════════════════ */
const Auth = {
  getToken() {
    return localStorage.getItem('pkm_token');
  },

  getUser() {
    try {
      return JSON.parse(localStorage.getItem('pkm_user'));
    } catch {
      return null;
    }
  },

  setSession(token, user) {
    localStorage.setItem('pkm_token', token);
    localStorage.setItem('pkm_user', JSON.stringify(user));
  },

  clear() {
    localStorage.removeItem('pkm_token');
    localStorage.removeItem('pkm_user');
  },

  isLoggedIn() {
    return !!this.getToken();
  },

  requireRole(roles = [], redirect = '/') {
    const user = this.getUser();
    if (!user || !this.getToken()) {
      this.clear();
      location.href = redirect;
      return null;
    }
    if (roles.length && !roles.includes(user.role)) {
      this.clear();
      location.href = redirect;
      return null;
    }
    return user;
  },
};

/* ══════════════════════════════════════════════════
   API FETCH — Wrapper fetch dengan:
   - Authorization header otomatis
   - Redirect ke login jika 401 (kecuali halaman publik)
   - Logging untuk debugging
   - Throw error dengan pesan dari server jika gagal
══════════════════════════════════════════════════ */
async function apiFetch(endpoint, options = {}) {
  const token = Auth.getToken();

  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const url = PKM.BASE_URL + endpoint;
  let res;
  try {
    console.log(`[API] ${options.method || 'GET'} ${url}`);
    res = await fetch(url, { ...options, headers });
  } catch (networkErr) {
    console.error('[API] Network error:', networkErr);
    throw new Error('Tidak dapat terhubung ke server. Periksa koneksi jaringan.');
  }

  console.log(`[API] Response ${res.status} for ${endpoint}`);

  // 401 = token tidak valid / expired
  if (res.status === 401) {
    const publicPaths = ['/display', '/kiosk'];
    const isPublic = publicPaths.some(p => location.pathname.startsWith(p));
    if (!isPublic) {
      Auth.clear();
      location.href = '/';
    }
    return;
  }

  let data;
  try {
    data = await res.json();
  } catch (parseErr) {
    console.error('[API] JSON parse error:', parseErr);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return {};
  }

  if (!res.ok) {
    throw new Error(data?.error || data?.message || `HTTP Error ${res.status}`);
  }

  return data;
}

/* ══════════════════════════════════════════════════
   WEBSOCKET — Koneksi realtime (auto‑reconnect)
   - Di localhost: WebSocket asli
   - Di production (Vercel): polling setiap 3 detik
══════════════════════════════════════════════════ */
function createWS(onMessage) {
  const isLocal = location.hostname === 'localhost' ||
                  location.hostname === '127.0.0.1';

  if (isLocal) {
    /* ── MODE LOKAL: WebSocket asli ── */
    let ws, retryTimer, destroyed = false;

    function connect() {
      if (destroyed) return;
      try {
        ws = new WebSocket(PKM.WS_URL);
        console.log('[WS] Connecting to', PKM.WS_URL);
      } catch (err) {
        console.warn('[WS] Connection error:', err.message);
        retryTimer = setTimeout(connect, 3000);
        return;
      }

      ws.onopen = () => console.log('[WS] Terhubung.');
      ws.onmessage = e => {
        try { onMessage(JSON.parse(e.data)); } catch (ex) {
          console.warn('[WS] Parse error:', ex);
        }
      };
      ws.onclose = () => {
        if (!destroyed) retryTimer = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
    }

    connect();

    return {
      close() {
        destroyed = true;
        clearTimeout(retryTimer);
        if (ws) ws.close();
      }
    };
  } else {
    /* ── MODE PRODUCTION: polling setiap 3 detik ── */
    console.log('[Polling] Production mode — polling setiap 3 detik ke', PKM.BASE_URL);
    let timer;

    async function poll() {
      try {
        const data = await apiFetch('/api/queue');
        if (data) {
          onMessage({ type: 'QUEUE_UPDATE', action: 'POLL', data });
        }
      } catch (err) {
        console.warn('[Polling] Gagal fetch:', err.message);
      }
      timer = setTimeout(poll, 3000);
    }

    poll();

    return {
      close() {
        clearTimeout(timer);
      }
    };
  }
}

/* ══════════════════════════════════════════════════
   KEEP‑ALIVE — Ping server agar tidak idle (Railway)
   Hanya berjalan di production.
══════════════════════════════════════════════════ */
function keepAlive() {
  const interval = 5 * 60 * 1000; // 5 menit
  setInterval(async () => {
    try {
      const res = await fetch(PKM.BASE_URL + '/health');
      console.log('[KeepAlive] Server aktif, status:', res.status);
    } catch (err) {
      console.warn('[KeepAlive] Gagal ping server:', err.message);
    }
  }, interval);
}

if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
  keepAlive();
}

/* ══════════════════════════════════════════════════
   TOAST NOTIFICATION
══════════════════════════════════════════════════ */
function showToast(title, msg, type = 'info', duration = 3500) {
  let container = document.getElementById('pkm-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'pkm-toast-container';
    container.style.cssText = [
      'position:fixed',
      'bottom:1.5rem',
      'right:1.5rem',
      'z-index:9999',
      'display:flex',
      'flex-direction:column',
      'gap:8px',
      'max-width:340px',
      'pointer-events:none',
    ].join(';');
    document.body.appendChild(container);
  }

  const colors = {
    success: '#22c55e',
    error:   '#ef4444',
    warn:    '#f59e0b',
    info:    '#60a5fa',
  };
  const accent = colors[type] || colors.info;

  const el = document.createElement('div');
  el.style.cssText = [
    'background:#1e293b',
    'color:#f1f5f9',
    'padding:10px 14px',
    'border-radius:10px',
    `border-left:3px solid ${accent}`,
    'font-size:13px',
    'box-shadow:0 8px 24px rgba(0,0,0,.25)',
    'animation:pkmToastIn .25s ease',
    'display:flex',
    'gap:10px',
    'align-items:flex-start',
    'font-family:inherit',
    'pointer-events:all',
  ].join(';');

  el.innerHTML = `
    <div style="flex:1">
      <div style="font-weight:600;font-size:12px;margin-bottom:2px;color:#fff">
        ${escHtml(title)}
      </div>
      <div style="opacity:.8;font-size:12px;line-height:1.4">
        ${escHtml(msg)}
      </div>
    </div>`;

  container.appendChild(el);

  setTimeout(() => {
    el.style.animation = 'pkmToastOut .25s ease forwards';
    setTimeout(() => el.remove(), 260);
  }, duration);
}

/* ══════════════════════════════════════════════════
   CONFIRM DIALOG — Pengganti window.confirm()
══════════════════════════════════════════════════ */
function showConfirm(title, body) {
  return new Promise(resolve => {
    let overlay = document.getElementById('pkm-confirm-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'pkm-confirm-overlay';
      overlay.style.cssText = [
        'position:fixed',
        'inset:0',
        'background:rgba(13,27,42,.5)',
        'z-index:10000',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'padding:1rem',
        'opacity:0',
        'transition:opacity .2s',
        'pointer-events:none',
        'font-family:inherit',
      ].join(';');

      overlay.innerHTML = `
        <div id="pkm-confirm-box" style="
          background:#fff;
          border-radius:16px;
          padding:1.5rem;
          max-width:380px;
          width:100%;
          box-shadow:0 20px 60px rgba(0,0,0,.2);
          transform:scale(.96);
          transition:transform .2s;
          font-family:inherit;
        ">
          <div id="pkm-confirm-title" style="
            font-size:16px;font-weight:600;color:#0c1a2b;margin-bottom:8px;
          "></div>
          <div id="pkm-confirm-body" style="
            font-size:13px;color:#3b5068;line-height:1.6;margin-bottom:1.25rem;
          "></div>
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button id="pkm-confirm-cancel" style="
              height:36px;padding:0 14px;border-radius:8px;
              border:1px solid #d0dcea;background:#f8fafd;
              color:#3b5068;font-size:13px;cursor:pointer;
              font-family:inherit;transition:.15s;
            ">Batal</button>
            <button id="pkm-confirm-ok" style="
              height:36px;padding:0 14px;border-radius:8px;
              border:none;background:#dc2626;color:#fff;
              font-size:13px;font-weight:600;cursor:pointer;
              font-family:inherit;transition:.15s;
            ">Konfirmasi</button>
          </div>
        </div>`;

      document.body.appendChild(overlay);
    }

    document.getElementById('pkm-confirm-title').textContent = title;
    document.getElementById('pkm-confirm-body').textContent  = body;

    overlay.style.opacity      = '1';
    overlay.style.pointerEvents = 'all';
    const box = document.getElementById('pkm-confirm-box');
    setTimeout(() => { box.style.transform = 'scale(1)'; }, 10);

    function cleanup(result) {
      overlay.style.opacity       = '0';
      overlay.style.pointerEvents = 'none';
      box.style.transform          = 'scale(.96)';
      resolve(result);
    }

    document.getElementById('pkm-confirm-ok').onclick     = () => cleanup(true);
    document.getElementById('pkm-confirm-cancel').onclick  = () => cleanup(false);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };
  });
}

/* ══════════════════════════════════════════════════
   UTILITIES
══════════════════════════════════════════════════ */

/**
 * Escape karakter HTML berbahaya untuk mencegah XSS.
 * @param {*} s
 * @returns {string}
 */
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format nomor antrian dengan leading zero (default 3 digit).
 * @param {number} n
 * @param {number} len
 * @returns {string}
 */
function padNum(n, len = 3) {
  return String(n).padStart(len, '0');
}

/**
 * Waktu sekarang dalam format HH:MM:SS.
 * @returns {string}
 */
function nowTime() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0'))
    .join(':');
}

/**
 * Format tanggal ke bahasa Indonesia (contoh: "Senin, 29 April 2026").
 * @param {Date|string|number} [d]
 * @returns {string}
 */
function formatDate(d) {
  return new Date(d || Date.now()).toLocaleDateString('id-ID', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}

/* ══════════════════════════════════════════════════
   GLOBAL CSS — Animasi toast & box‑sizing
══════════════════════════════════════════════════ */
(function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
    @keyframes pkmToastIn {
      from { opacity: 0; transform: translateX(20px); }
      to   { opacity: 1; transform: translateX(0); }
    }
    @keyframes pkmToastOut {
      from { opacity: 1; transform: translateX(0); }
      to   { opacity: 0; transform: translateX(20px); }
    }
    *, *::before, *::after { box-sizing: border-box; }
  `;
  document.head.appendChild(style);
})();
