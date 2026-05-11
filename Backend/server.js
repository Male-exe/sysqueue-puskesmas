/**
 * UPTD Puskesmas Cangadi — Backend Produksi
 * Auth: JWT + bcrypt | Roles: admin, petugas, patient
 * Stack: Node.js + Express + MariaDB/MySQL + WebSocket
 *
 * Install: npm install express mysql2 ws cors dotenv bcryptjs jsonwebtoken
 */

require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const path        = require('path');
const { createServer } = require('http');
const WebSocket   = require('ws');
const mysql       = require('mysql2/promise');
const bcrypt      = require('bcryptjs');
const jwt         = require('jsonwebtoken');

const app    = express();
const server = createServer(app);
const wss    = new WebSocket.Server({ server });

/* ─── CONFIG ─────────────────────────────────────────────────── */
const PORT        = process.env.PORT        || 3000;
const JWT_SECRET  = process.env.JWT_SECRET  || 'ganti_dengan_secret_panjang_acak_di_produksi';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';
const DB = {
  host:             process.env.DB_HOST     || 'localhost',
  user:             process.env.DB_USER     || 'root',
  password:         process.env.DB_PASS     || '',
  database:         process.env.DB_NAME     || 'rs_antrian',
  waitForConnections: true,
  connectionLimit:  10,
};

/* ─── DATABASE ───────────────────────────────────────────────── */
let pool;

async function initDB() {
  pool = await mysql.createPool(DB);

  // Tabel users
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      username   VARCHAR(50)  NOT NULL UNIQUE,
      password   VARCHAR(255) NOT NULL,
      full_name  VARCHAR(100) NOT NULL,
      role       ENUM('admin','petugas','patient') NOT NULL DEFAULT 'petugas',
      poli_id    INT          NULL,
      is_active  TINYINT(1)   NOT NULL DEFAULT 1,
      created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Tabel polyclinics
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS polyclinics (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      code       VARCHAR(10)  NOT NULL UNIQUE,
      name       VARCHAR(80)  NOT NULL,
      is_active  TINYINT(1)   NOT NULL DEFAULT 1,
      created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Tabel queues
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS queues (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      queue_number INT          NOT NULL,
      name         VARCHAR(100) NOT NULL DEFAULT 'Pasien Anonim',
      poli_id      INT          NOT NULL,
      poli_name    VARCHAR(80)  NOT NULL,
      status       ENUM('waiting','called','done') NOT NULL DEFAULT 'waiting',
      called_by    INT          NULL,
      created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Seed data awal jika belum ada
  const [polis] = await pool.execute('SELECT COUNT(*) as c FROM polyclinics');
  if (polis[0].c === 0) {
    await pool.execute(`
      INSERT INTO polyclinics (code, name) VALUES
      ('K2U','Klaster 2 Umum'), ('K3U','Klaster 3 Umum'), ('K2KIA','Klaster 2 KIA'),
      ('K3KB','Klaster 3 KB'), ('GIGI','Poli GIGI')
    `);
    console.log('✅ Seed polyclinics selesai.');
  }

  const [admins] = await pool.execute("SELECT COUNT(*) as c FROM users WHERE role='admin'");
  if (admins[0].c === 0) {
    const hash = await bcrypt.hash('admin123', 12);
    await pool.execute(
      "INSERT INTO users (username, password, full_name, role) VALUES (?,?,?,'admin')",
      ['admin', hash, 'Administrator']
    );
    console.log('✅ Akun admin default dibuat → username: admin | password: admin123');
    console.log('⚠️  Segera ganti password admin setelah login pertama!');
  }

  console.log('✅ Database siap.');
}

/* ─── WEBSOCKET ──────────────────────────────────────────────── */
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

wss.on('connection', ws => {
  console.log(`🔌 WS client terhubung (${wss.clients.size})`);
  ws.on('close', () => console.log(`🔌 WS client terputus (${wss.clients.size})`));
});

/* ─── MIDDLEWARE ─────────────────────────────────────────────── */
app.use(cors({
  origin: [
    'https://sysqueue-puskesmas.vercel.app',
    'http://localhost:3000',
  ],
  credentials: true,
}));
app.use(express.json());
app.use('/assets', express.static(path.join(__dirname, 'assets')));

/* ─── AUTH MIDDLEWARE ────────────────────────────────────────── */
function authMiddleware(roles = []) {
  return (req, res, next) => {
    const header = req.headers['authorization'] || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Token tidak ditemukan. Silakan login.' });
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (roles.length && !roles.includes(decoded.role)) {
        return res.status(403).json({ error: 'Akses ditolak. Role tidak sesuai.' });
      }
      req.user = decoded;
      next();
    } catch {
      return res.status(401).json({ error: 'Token tidak valid atau sudah kedaluwarsa.' });
    }
  };
}

/* ─── HELPERS ────────────────────────────────────────────────── */
function nowTime() {
  return new Date().toLocaleTimeString('id-ID', { hour12: false });
}

async function getNextQueueNumber(poliId) {
  // ANTRIAN GLOBAL - nomor berurutan untuk semua poli
  const [rows] = await pool.execute(
    `SELECT COALESCE(MAX(queue_number), 0) + 1 AS n
     FROM queues WHERE DATE(created_at) = CURDATE()`
  );
  return rows[0].n;
}

function fmtQueue(r) {
  return {
    id:          r.id,
    queueNumber: r.queue_number,
    name:        r.name,
    poliId:      r.poli_id,
    poliName:    r.poli_name,
    status:      r.status,
    timestamp:   r.created_at
      ? new Date(r.created_at).toLocaleTimeString('id-ID', { hour12: false })
      : nowTime(),
    createdAt:   r.created_at,
  };
}

/* ═══════════════════════════════════════════════════════════════
   ROUTES
   ═══════════════════════════════════════════════════════════════ */

/* ─── AUTH ───────────────────────────────────────────────────── */
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Username dan password wajib diisi.' });

  try {
    const [rows] = await pool.execute(
      'SELECT * FROM users WHERE username = ? AND is_active = 1', [username]
    );
    if (!rows.length)
      return res.status(401).json({ error: 'Username atau password salah.' });

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match)
      return res.status(401).json({ error: 'Username atau password salah.' });

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role,
        fullName: user.full_name, poliId: user.poli_id },
      JWT_SECRET, { expiresIn: JWT_EXPIRES }
    );

    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role,
              fullName: user.full_name, poliId: user.poli_id }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Kesalahan server.' });
  }
});

app.get('/api/auth/me', authMiddleware(), (req, res) => {
  res.json({ user: req.user });
});

/* ─── POLYCLINICS ────────────────────────────────────────────── */
app.get('/api/polyclinics', async (_req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM polyclinics WHERE is_active = 1 ORDER BY name'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil data poliklinik.' });
  }
});

app.post('/api/polyclinics', authMiddleware(['admin']), async (req, res) => {
  const { code, name } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: 'Code dan nama wajib diisi.' });
  try {
    const [r] = await pool.execute(
      'INSERT INTO polyclinics (code, name) VALUES (?, ?)',
      [code.toUpperCase(), name]
    );
    res.status(201).json({ id: r.insertId, code: code.toUpperCase(), name });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(400).json({ error: 'Kode poliklinik sudah ada.' });
    res.status(500).json({ error: 'Gagal menambah poliklinik.' });
  }
});

app.put('/api/polyclinics/:id', authMiddleware(['admin']), async (req, res) => {
  const { name, is_active } = req.body || {};
  try {
    await pool.execute(
      'UPDATE polyclinics SET name = ?, is_active = ? WHERE id = ?',
      [name, is_active !== undefined ? is_active : 1, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Gagal update poliklinik.' });
  }
});

/* ─── USERS (admin only) ─────────────────────────────────────── */
app.get('/api/users', authMiddleware(['admin']), async (_req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, username, full_name, role, poli_id, is_active, created_at FROM users ORDER BY role, full_name'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil data pengguna.' });
  }
});

app.post('/api/users', authMiddleware(['admin']), async (req, res) => {
  const { username, password, full_name, role, poli_id } = req.body || {};
  if (!username || !password || !full_name || !role)
    return res.status(400).json({ error: 'Semua field wajib diisi.' });
  if (!['admin','petugas'].includes(role))
    return res.status(400).json({ error: 'Role tidak valid.' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const [r] = await pool.execute(
      'INSERT INTO users (username, password, full_name, role, poli_id) VALUES (?,?,?,?,?)',
      [username, hash, full_name, role, poli_id || null]
    );
    res.status(201).json({ id: r.insertId, username, full_name, role });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY')
      return res.status(400).json({ error: 'Username sudah digunakan.' });
    res.status(500).json({ error: 'Gagal membuat pengguna.' });
  }
});

app.put('/api/users/:id', authMiddleware(['admin']), async (req, res) => {
  const { full_name, role, poli_id, is_active, password } = req.body || {};
  try {
    if (password) {
      const hash = await bcrypt.hash(password, 12);
      await pool.execute(
        'UPDATE users SET full_name=?, role=?, poli_id=?, is_active=?, password=? WHERE id=?',
        [full_name, role, poli_id || null, is_active, hash, req.params.id]
      );
    } else {
      await pool.execute(
        'UPDATE users SET full_name=?, role=?, poli_id=?, is_active=? WHERE id=?',
        [full_name, role, poli_id || null, is_active, req.params.id]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Gagal update pengguna.' });
  }
});

app.delete('/api/users/:id', authMiddleware(['admin']), async (req, res) => {
  if (parseInt(req.params.id) === req.user.id)
    return res.status(400).json({ error: 'Tidak dapat menghapus akun sendiri.' });
  try {
    await pool.execute('UPDATE users SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Gagal menonaktifkan pengguna.' });
  }
});

/* ─── QUEUE ──────────────────────────────────────────────────── */

// GET antrian aktif (public — untuk display & kiosk)
app.get('/api/queue', async (req, res) => {
  try {
    const poliFilter = req.query.poli_id
      ? 'AND q.poli_id = ?' : '';
    const params = req.query.poli_id ? [req.query.poli_id] : [];
    const [rows] = await pool.execute(
      `SELECT q.* FROM queues q
       WHERE q.status IN ('waiting','called')
         AND DATE(q.created_at) = CURDATE()
         ${poliFilter}
       ORDER BY q.queue_number ASC`,
      params
    );
    res.json(rows.map(fmtQueue));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gagal mengambil antrian.' });
  }
});

// POST ambil nomor antrian (patient / public)
app.post('/api/queue', async (req, res) => {
  const name   = (req.body.name  || '').trim() || 'Pasien Anonim';
  const poliId = parseInt(req.body.poli_id);
  if (!poliId || isNaN(poliId))
    return res.status(400).json({ error: 'Pilih poliklinik terlebih dahulu.' });

  try {
    const [polis] = await pool.execute(
      'SELECT * FROM polyclinics WHERE id = ? AND is_active = 1', [poliId]
    );
    if (!polis.length)
      return res.status(404).json({ error: 'Poliklinik tidak ditemukan.' });

    const qNum  = await getNextQueueNumber(poliId);
    const [ins] = await pool.execute(
      'INSERT INTO queues (queue_number, name, poli_id, poli_name) VALUES (?,?,?,?)',
      [qNum, name, poliId, polis[0].name]
    );
    const [rows] = await pool.execute('SELECT * FROM queues WHERE id = ?', [ins.insertId]);
    const item = fmtQueue(rows[0]);
    broadcast({ type: 'QUEUE_UPDATE', action: 'ADD', item });
    res.status(201).json(item);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gagal mendaftar antrian.' });
  }
});

// PUT panggil antrian spesifik (petugas/admin)
app.put('/api/queue/:id/call', authMiddleware(['petugas','admin']), async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    // Selesaikan yang sedang called di poli yang sama
    const [target] = await pool.execute('SELECT * FROM queues WHERE id = ?', [id]);
    if (!target.length)
      return res.status(404).json({ error: 'Antrian tidak ditemukan.' });
    if (target[0].status !== 'waiting')
      return res.status(400).json({ error: 'Pasien sudah dipanggil atau selesai.' });

    await pool.execute(
      "UPDATE queues SET status='done' WHERE status='called' AND poli_id = ?",
      [target[0].poli_id]
    );
    await pool.execute(
      "UPDATE queues SET status='called', called_by=? WHERE id=?",
      [req.user.id, id]
    );
    const [rows] = await pool.execute('SELECT * FROM queues WHERE id = ?', [id]);
    const item = fmtQueue(rows[0]);
    broadcast({ type: 'QUEUE_UPDATE', action: 'CALL', item });
    res.json(item);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gagal memanggil pasien.' });
  }
});

// POST panggil berikutnya (petugas/admin)
app.post('/api/queue/call-next', authMiddleware(['petugas','admin']), async (req, res) => {
  // Petugas hanya bisa panggil poli mereka sendiri (kecuali admin)
  const poliId = req.user.role === 'admin'
    ? (req.body.poli_id || null)
    : req.user.poliId;

  try {
    const poliFilter = poliId ? 'AND poli_id = ?' : '';
    const params     = poliId ? [poliId] : [];

    await pool.execute(
      `UPDATE queues SET status='done' WHERE status='called' ${poliFilter}`,
      params
    );

    const [waiting] = await pool.execute(
      `SELECT * FROM queues
       WHERE status='waiting' AND DATE(created_at)=CURDATE() ${poliFilter}
       ORDER BY queue_number ASC LIMIT 1`,
      params
    );
    if (!waiting.length)
      return res.status(404).json({ error: 'Tidak ada antrian menunggu.' });

    await pool.execute(
      "UPDATE queues SET status='called', called_by=? WHERE id=?",
      [req.user.id, waiting[0].id]
    );
    const item = fmtQueue({ ...waiting[0], status: 'called' });
    broadcast({ type: 'QUEUE_UPDATE', action: 'CALL_NEXT', item });
    res.json(item);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gagal memanggil antrian berikutnya.' });
  }
});

// PUT selesaikan layanan (petugas/admin)
app.put('/api/queue/:id/finish', authMiddleware(['petugas','admin']), async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const [rows] = await pool.execute('SELECT * FROM queues WHERE id = ?', [id]);
    if (!rows.length)
      return res.status(404).json({ error: 'Antrian tidak ditemukan.' });
    if (rows[0].status !== 'called')
      return res.status(400).json({ error: 'Hanya pasien yang sedang dipanggil yang dapat diselesaikan.' });

    await pool.execute("UPDATE queues SET status='done' WHERE id=?", [id]);
    const item = fmtQueue({ ...rows[0], status: 'done' });
    broadcast({ type: 'QUEUE_UPDATE', action: 'FINISH', item });
    res.json(item);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gagal menyelesaikan layanan.' });
  }
});

// POST panggil ulang (recall) — hanya broadcast, tidak ubah status
app.post('/api/queue/recall', authMiddleware(['petugas','admin']), async (req, res) => {
  try {
    const poliId = req.user.role === 'admin'
      ? (req.body.poli_id || null)
      : req.user.poliId;

    const poliFilter = poliId ? 'AND poli_id = ?' : '';
    const params     = poliId ? [poliId] : [];

    /* Cari antrian yang sedang dipanggil (called) */
    const [called] = await pool.execute(
      `SELECT * FROM queues WHERE status='called' ${poliFilter} LIMIT 1`,
      params
    );
    if (!called.length)
      return res.status(404).json({ error: 'Tidak ada antrian yang sedang dipanggil.' });

    const item = fmtQueue(called[0]);
    /* Broadcast action RECALL ke semua client (display akan putar suara ulang) */
    broadcast({ type: 'QUEUE_UPDATE', action: 'RECALL', item });
    res.json(item);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Gagal memanggil ulang.' });
  }
});

// DELETE reset antrian (admin only)
app.delete('/api/queue/reset', authMiddleware(['admin']), async (_req, res) => {
  try {
    await pool.execute(
      "UPDATE queues SET status='done' WHERE status IN ('waiting','called')"
    );
    broadcast({ type: 'QUEUE_UPDATE', action: 'RESET' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Gagal mereset antrian.' });
  }
});

/* ─── STATS & EXPORT (admin) ─────────────────────────────────── */
app.get('/api/stats', authMiddleware(['admin','petugas']), async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  try {
    const [total] = await pool.execute(
      `SELECT
         COUNT(*) AS total,
         SUM(status='waiting') AS waiting,
         SUM(status='called')  AS called,
         SUM(status='done')    AS done
       FROM queues WHERE DATE(created_at) = ?`, [date]
    );
    const [byPoli] = await pool.execute(
      `SELECT poli_name,
         COUNT(*) AS total,
         SUM(status='done') AS done,
         SUM(status='waiting') AS waiting
       FROM queues WHERE DATE(created_at) = ?
       GROUP BY poli_id, poli_name ORDER BY poli_name`, [date]
    );
    res.json({ date, summary: total[0], byPoli });
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil statistik.' });
  }
});

// GET stats publik (untuk display — tidak perlu login)
app.get('/api/stats/public', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  try {
    const [total] = await pool.execute(
      `SELECT
         COUNT(*) AS total,
         SUM(status='waiting') AS waiting,
         SUM(status='called')  AS called,
         SUM(status='done')    AS done
       FROM queues WHERE DATE(created_at) = ?`, [date]
    );
    res.json({ date, summary: total[0] });
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil statistik.' });
  }
});

// Export CSV
app.get('/api/export/csv', authMiddleware(['admin']), async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  try {
    const [rows] = await pool.execute(
      `SELECT queue_number, name, poli_name, status,
              DATE_FORMAT(created_at,'%H:%i:%s') AS waktu_daftar,
              DATE_FORMAT(updated_at,'%H:%i:%s') AS waktu_update
       FROM queues WHERE DATE(created_at) = ?
       ORDER BY poli_id, queue_number`, [date]
    );
    const header = 'No Antrian,Nama Pasien,Poliklinik,Status,Waktu Daftar,Waktu Update\n';
    const body   = rows.map(r =>
      `${r.queue_number},"${r.name}","${r.poli_name}",${r.status},${r.waktu_daftar},${r.waktu_update}`
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="antrian-${date}.csv"`);
    res.send('\uFEFF' + header + body); // BOM untuk Excel
  } catch (err) {
    res.status(500).json({ error: 'Gagal export CSV.' });
  }
});

/* ─── STATIC PAGES ───────────────────────────────────────────── */
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/kiosk',   (_req, res) => res.sendFile(path.join(__dirname, 'public', 'kiosk.html')));
app.get('/petugas', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'petugas.html')));
app.get('/display', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'display.html')));
app.get('/admin',   (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

/* ─── HEALTH ─────────────────────────────────────────────────── */
app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

/* ─── START ──────────────────────────────────────────────────── */
initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`\n🚀 Server: http://localhost:${PORT}`);
    console.log(`📱 Kiosk  : http://localhost:${PORT}/kiosk`);
    console.log(`💼 Petugas: http://localhost:${PORT}/petugas`);
    console.log(`📺 Display: http://localhost:${PORT}/display`);
    console.log(`⚙️  Admin  : http://localhost:${PORT}/admin\n`);
  });
}).catch(err => {
  console.error('❌ DB Error:', err.message);
  process.exit(1);
});
