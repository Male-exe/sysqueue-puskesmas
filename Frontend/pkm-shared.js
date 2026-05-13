/**
 * pkm-shared.js — Utilitas bersama semua halaman
 * UPTD Puskesmas Cangadi — Sistem Antrian
 *
 * Versi: 2.0 (terbaru)
 * Include di setiap HTML:
 *   <script src="/pkm-shared.js"></script>
 *
 * Berisi:
 *  - Auth     : manajemen sesi JWT (login, logout, cek role)
 *  - apiFetch : wrapper fetch dengan token otomatis
 *  - createWS : WebSocket dengan auto-reconnect
 *  - showToast: notifikasi pop-up
 *  - showConfirm: dialog konfirmasi custom
 *  - Utilities: escHtml, padNum, nowTime, formatDate
 *  - Global CSS: animasi toast
 */

/* ══════════════════════════════════════════════════
   CONFIG
   BASE_URL kosong = same origin (server & frontend
   satu port). Ubah jika frontend dan backend terpisah.
══════════════════════════════════════════════════ */
const PKM = {
  BASE_URL: 'https://backend-sysqueue.up.railway.app',
  WS_URL:   `ws://${location.host}`,
};

/* ══════════════════════════════════════════════════
   AUTH — Manajemen sesi JWT via localStorage
══════════════════════════════════════════════════ */
const Auth = {
  /**
   * Ambil token JWT dari storage.
   * @returns {string|null}
   */
  getToken() {
    return localStorage.getItem('pkm_token');
  },

  /**
   * Ambil data user yang sedang login.
   * @returns {object|null}
   */
  getUser() {
    try {
      return JSON.parse(localStorage.getItem('pkm_user'));
    } catch {
      return null;
    }
  },

  /**
   * Simpan token dan data user setelah login berhasil.
   * @param {string} token
   * @param {object} user
   */
  setSession(token, user) {
    localStorage.setItem('pkm_token', token);
    localStorage.setItem('pkm_user',  JSON.stringify(user));
  },

  /**
   * Hapus sesi (logout).
   */
  clear() {
    localStorage.removeItem('pkm_token');
    localStorage.removeItem('pkm_user');
  },

  /**
   * Cek apakah user sedang login.
   * @returns {boolean}
   */
  isLoggedIn() {
    return !!this.getToken();
  },

  /**
   * Pastikan user sudah login dan punya role yang sesuai.
   * Jika tidak, redirect ke halaman login.
   * @param {string[]} roles  — daftar role yang diizinkan, mis. ['admin','petugas']
   * @param {string}   redirect — URL tujuan jika tidak authorized (default '/')
   * @returns {object} data user jika authorized
   */
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
   - Header Authorization otomatis dari Auth.getToken()
   - Redirect ke login jika 401
   - Halaman publik (display, kiosk) tidak di-redirect
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

  let res;
  try {
    res = await fetch(PKM.BASE_URL + endpoint, { ...options, headers });
  } catch (networkErr) {
    throw new Error('Tidak dapat terhubung ke server. Periksa koneksi jaringan.');
  }

  /* 401 = token tidak valid / expired */
  if (res.status === 401) {
    /* halaman publik (display & kiosk) tidak perlu redirect login */
    const publicPaths = ['/display', '/kiosk'];
    const isPublic    = publicPaths.some(p => location.pathname.startsWith(p));
    if (!isPublic) {
      Auth.clear();
      location.href = '/';
    }
    return; /* return undefined, biarkan caller handle */
  }

  /* parse JSON */
  let data;
  try {
    data = await res.json();
  } catch {
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    return {};
  }

  if (!res.ok) {
    throw new Error(data?.error || data?.message || `HTTP Error ${res.status}`);
  }

  return data;
}

/* ══════════════════════════════════════════════════
   WEBSOCKET — Koneksi real-time dengan auto-reconnect
══════════════════════════════════════════════════ */
/**
 * Buat koneksi WebSocket yang otomatis reconnect.
 * @param {function} onMessage — callback dipanggil saat pesan diterima (sudah di-parse JSON)
 * @returns {{ close: function }} — object dengan method close() untuk menutup koneksi
 */
/**
 * createWS — Di production (Vercel+Railway) pakai polling karena
 * WebSocket tidak reliable melewati Vercel CDN.
 * Di localhost tetap pakai WebSocket asli.
 */
function createWS(onMessage) {
  /* Deteksi apakah di production atau localhost */
  const isLocal = location.hostname === 'localhost' ||
                  location.hostname === '127.0.0.1';

  if (isLocal) {
    /* ── MODE LOKAL: pakai WebSocket asli ── */
    let ws, retryTimer, destroyed = false;

    function connect() {
      if (destroyed) return;
      try {
        ws = new WebSocket(PKM.WS_URL);
      } catch (err) {
        console.warn('[WS] Gagal:', err.message);
        retryTimer = setTimeout(connect, 3000);
        return;
      }
      ws.onopen    = () => console.log('[WS] Terhubung.');
      ws.onmessage = e => {
        try { onMessage(JSON.parse(e.data)); } catch {}
      };
      ws.onclose   = () => { if (!destroyed) retryTimer = setTimeout(connect, 3000); };
      ws.onerror   = () => ws.close();
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
    /* ── MODE PRODUCTION: pakai polling setiap 3 detik ── */
    console.log('[Polling] Mode production aktif — polling setiap 3 detik.');
    let timer;
    let lastAction = null;

    async function poll() {
      try {
        const data = await apiFetch('/api/queue');
        if (data) {
          /* Kirim pesan simulasi QUEUE_UPDATE agar halaman update */
          onMessage({ type: 'QUEUE_UPDATE', action: 'POLL', data });
        }
      } catch {}
      timer = setTimeout(poll, 3000);
    }

    poll(); /* mulai langsung */
    return { close() { clearTimeout(timer); } };
  }
}

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, 3000);
  }

  connect();

  return {
    close() {
      destroyed = true;
      clearTimeout(retryTimer);
      if (ws) ws.close();
    }
  };
}

/* ══════════════════════════════════════════════════
   TOAST NOTIFICATION
   Muncul di pojok kanan bawah, hilang otomatis.
══════════════════════════════════════════════════ */
/**
 * Tampilkan notifikasi pop-up.
 * @param {string} title   — judul singkat
 * @param {string} msg     — pesan detail
 * @param {'info'|'success'|'warn'|'error'} type
 * @param {number} duration — durasi tampil dalam ms (default 3500)
 */
function showToast(title, msg, type = 'info', duration = 3500) {
  /* buat container jika belum ada */
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
   CONFIRM DIALOG — Pengganti window.confirm() bawaan
   browser yang tampilannya tidak bisa dikustomisasi.
══════════════════════════════════════════════════ */
/**
 * Tampilkan dialog konfirmasi custom.
 * @param {string} title
 * @param {string} body
 * @returns {Promise<boolean>} — true jika dikonfirmasi, false jika dibatalkan
 */
function showConfirm(title, body) {
  return new Promise(resolve => {
    /* buat overlay jika belum ada */
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

    /* isi konten */
    document.getElementById('pkm-confirm-title').textContent = title;
    document.getElementById('pkm-confirm-body').textContent  = body;

    /* tampilkan */
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
 * WAJIB dipakai saat menampilkan data dari user/server ke innerHTML.
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
 * Format nomor antrian dengan leading zero.
 * Contoh: padNum(5) → "005", padNum(12) → "012"
 * @param {number} n
 * @param {number} len — panjang total (default 3)
 * @returns {string}
 */
function padNum(n, len = 3) {
  return String(n).padStart(len, '0');
}

/**
 * Ambil waktu sekarang dalam format HH:MM:SS.
 * @returns {string}
 */
function nowTime() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0'))
    .join(':');
}

/**
 * Format tanggal ke bahasa Indonesia.
 * Contoh: "Senin, 29 April 2026"
 * @param {Date|string|number} [d] — default: sekarang
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
   GLOBAL CSS — Inject animasi untuk toast
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
