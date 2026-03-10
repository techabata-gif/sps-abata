require("dotenv").config();
const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- HELPER: FUNGSI HITUNG JARAK ---
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000; 
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c; 
}

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ ok: false, error: "Silakan login" });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ ok: false, error: "Sesi berakhir" });
    req.user = user;
    next();
  });
};

// ==========================================
// AUTH & PROFILE
// ==========================================
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const userRes = await pool.query("SELECT * FROM Users WHERE Username = $1 AND IsActive = TRUE", [username]);
    if (userRes.rows.length === 0) return res.status(401).json({ ok: false, error: "User tidak ditemukan" });
    const user = userRes.rows[0];
    const valid = await bcrypt.compare(password, user.passwordhash);
    if (!valid) return res.status(401).json({ ok: false, error: "Password salah" });
    const roleRes = await pool.query("SELECT PermissionsJson FROM Roles WHERE Role = $1", [user.role]);
    const permissions = roleRes.rows[0].permissionsjson;
    const token = jwt.sign({ userId: user.userid, username: user.username, role: user.role, permissions }, process.env.JWT_SECRET, { expiresIn: "12h" });
    res.json({ ok: true, data: { token, user: { UserId: user.userid, Name: user.name, Role: user.role, permissions } } });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get("/api/me", authenticateToken, async (req, res) => {
  try {
    const userRes = await pool.query("SELECT UserId as \"UserId\", Name as \"Name\", Username as \"Username\", Role as \"Role\" FROM Users WHERE UserId = $1", [req.user.userId]);
    res.json({ ok: true, data: { ...userRes.rows[0], permissions: req.user.permissions } });
  } catch (err) { res.status(500).json({ ok: false }); }
});

// ==========================================
// SCHEDULES
// ==========================================
// ==========================================
// SCHEDULES (PENGATURAN DURASI & JAM MULAI)
// ==========================================
// ==========================================
// PENGATURAN JADWAL GLOBAL (MASTER SETTING)
// ==========================================
app.get("/api/schedules", authenticateToken, async (req, res) => {
  try {
    // Ambil 1 baris pengaturan saja
    const result = await pool.query("SELECT StartHour, IntervalHours FROM Schedules LIMIT 1");
    // Jika tabel kosong, kembalikan default 7 dan 2
    const data = result.rows.length > 0 ? result.rows[0] : { starthour: 7, intervalhours: 2 };
    res.json({ ok: true, data: data });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.put("/api/schedules", authenticateToken, async (req, res) => {
  const { StartHour, IntervalHours } = req.body;
  try {
    // Karena ini setting global, kita update semua baris (yang mana hanya ada 1 baris)
    await pool.query("UPDATE Schedules SET StartHour=$1, IntervalHours=$2", [StartHour, IntervalHours]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ==========================================
// SCAN & LOGS
// ==========================================
app.post("/api/scan", authenticateToken, async (req, res) => {
  // Tambahkan penangkapan variabel "method" dari frontend
  const { barcode, lat, lng, method } = req.body; 
  try {
    const cpRes = await pool.query("SELECT * FROM Checkpoints WHERE BarcodeValue = $1 AND Active = TRUE", [barcode]);
    if (cpRes.rows.length === 0) return res.status(404).json({ ok: false, error: "Checkpoint tidak ditemukan!" });

    const cp = cpRes.rows[0];
    if (cp.latitude && cp.longitude) {
      const distance = getDistance(lat, lng, parseFloat(cp.latitude), parseFloat(cp.longitude));
      const radiusLimit = cp.radiusmeters || 50;
      if (distance > radiusLimit) {
        return res.status(400).json({ ok: false, error: `Terlalu jauh! Jarak: ${Math.round(distance)} meter.` });
      }
    }

    // Tambahkan ScanMethod ke perintah INSERT
    await pool.query(
      "INSERT INTO PatrolLogs (CheckpointId, UserId, Username, BarcodeValue, Timestamp, Result, ScanMethod) VALUES ($1, $2, $3, $4, NOW(), $5, $6)",
      [cp.checkpointid, req.user.userId, req.user.username, barcode, 'OK', method || 'Tidak Diketahui']
    );
    res.json({ ok: true, data: { locationName: cp.name } });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});


// ==========================================
// REPORTS & MATRIX (12 SLOTS / 24H) - FIXED TIMEZONE
// ==========================================
app.get("/api/reports/matrix", authenticateToken, async (req, res) => {
  const { month, year } = req.query;
  try {
    const schedRes = await pool.query("SELECT StartHour, IntervalHours FROM Schedules WHERE IsActive = TRUE LIMIT 1");
    let startHour = 7;
    let interval = 2;
    
    if (schedRes.rows.length > 0) {
      startHour = parseInt(schedRes.rows[0].starthour);
      interval = parseInt(schedRes.rows[0].intervalhours);
    }
    
    if (interval < 1) interval = 1; 
    const totalSteps = Math.floor(24 / interval);

    const query = `
      WITH RECURSIVE hours AS (
          SELECT $3::int AS start_hour, 1 AS step
          UNION ALL 
          SELECT (start_hour + $4::int) % 24, step + 1 FROM hours WHERE step < $5::int
      ),
      days AS (
          SELECT generate_series(
            date_trunc('month', make_date($2, $1, 1)), 
            (date_trunc('month', make_date($2, $1, 1)) + interval '1 month' - interval '1 day'), 
            interval '1 day'
          )::date AS date
      )
      SELECT 
        EXTRACT(DAY FROM d.date) as tgl, 
        LPAD(h.start_hour::text, 2, '0') || ':00' AS jam_slot, 
        c.Name AS lokasi, 
        STRING_AGG(DISTINCT UPPER(LEFT(l.Username, 3)), ' / ') AS inisial,
        COUNT(CASE WHEN u.GuardType = 'Inhouse' THEN 1 END) as scan_inhouse,
        COUNT(CASE WHEN u.GuardType = 'Outsource' THEN 1 END) as scan_outsource
      FROM days d 
      CROSS JOIN hours h 
      CROSS JOIN Checkpoints c
      LEFT JOIN PatrolLogs l ON 
        l.CheckpointId = c.CheckpointId AND 
        (l.Timestamp + INTERVAL '7 hours')::date = d.date AND
        EXTRACT(HOUR FROM (l.Timestamp + INTERVAL '7 hours')) = h.start_hour
      LEFT JOIN Users u ON l.UserId = u.UserId
      GROUP BY d.date, h.start_hour, c.Name, h.step
      ORDER BY h.step ASC, lokasi ASC, tgl ASC;
    `;
    const result = await pool.query(query, [parseInt(month), parseInt(year), startHour, interval, totalSteps]);
    res.json({ ok: true, data: result.rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ==========================================
// DATA MANAGEMENT (USERS & CHECKPOINTS)
// ==========================================
// ==========================================
// DATA MANAGEMENT (USERS & CHECKPOINTS)
// ==========================================
app.get("/api/users", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query("SELECT UserId as \"UserId\", Name as \"Name\", Username as \"Username\", Role as \"Role\", GuardType as \"Tipe\", IsActive as \"IsActive\" FROM Users ORDER BY Name ASC");
    res.json({ ok: true, data: result.rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post("/api/users", authenticateToken, async (req, res) => {
  const { Name, Username, Password, Role, IsActive, GuardType } = req.body;
  try {
    const hash = await bcrypt.hash(Password, 10);
    await pool.query("INSERT INTO Users (Name, Username, PasswordHash, Role, IsActive, GuardType) VALUES ($1, $2, $3, $4, $5, $6)", [Name, Username, hash, Role, IsActive, GuardType || 'Inhouse']);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.put("/api/users", authenticateToken, async (req, res) => {
  const { UserId, Name, Password, Role, IsActive, GuardType } = req.body;
  try {
    if (Password && Password.trim() !== "") {
      const hash = await bcrypt.hash(Password, 10);
      await pool.query("UPDATE Users SET Name=$1, PasswordHash=$2, Role=$3, IsActive=$4, GuardType=$5 WHERE UserId=$6", [Name, hash, Role, IsActive, GuardType || 'Inhouse', UserId]);
    } else {
      await pool.query("UPDATE Users SET Name=$1, Role=$2, IsActive=$3, GuardType=$4 WHERE UserId=$5", [Name, Role, IsActive, GuardType || 'Inhouse', UserId]);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get("/api/checkpoints", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query("SELECT CheckpointId as \"CheckpointId\", Name as \"Name\", BarcodeValue as \"BarcodeValue\", Latitude as \"Latitude\", Longitude as \"Longitude\", RadiusMeters as \"RadiusMeters\", Active as \"Active\" FROM Checkpoints ORDER BY Name ASC");
    res.json({ ok: true, data: result.rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post("/api/checkpoints", authenticateToken, async (req, res) => {
  const { Name, BarcodeValue, Latitude, Longitude, RadiusMeters, Active } = req.body;
  try {
    await pool.query("INSERT INTO Checkpoints (Name, BarcodeValue, Latitude, Longitude, RadiusMeters, Active) VALUES ($1, $2, $3, $4, $5, $6)", [Name, BarcodeValue, Latitude, Longitude, RadiusMeters, Active]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.put("/api/checkpoints", authenticateToken, async (req, res) => {
  const { CheckpointId, Name, BarcodeValue, Latitude, Longitude, RadiusMeters, Active } = req.body;
  try {
    await pool.query("UPDATE Checkpoints SET Name=$1, BarcodeValue=$2, Latitude=$3, Longitude=$4, RadiusMeters=$5, Active=$6 WHERE CheckpointId=$7", [Name, BarcodeValue, Latitude, Longitude, RadiusMeters, Active, CheckpointId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ==========================================
// SYSTEM & STORAGE MAINTENANCE
// ==========================================

// Endpoint untuk cek ukuran database
app.get("/api/system/status", authenticateToken, async (req, res) => {
  try {
    // Hanya Admin yang boleh mengakses
    if (!req.user.permissions.includes('all')) return res.status(403).json({ ok: false, error: "Akses ditolak" });

    // Fungsi PostgreSQL bawaan untuk mengecek ukuran DB
    const dbSizeRes = await pool.query("SELECT pg_size_pretty(pg_database_size(current_database())) as size_text, pg_database_size(current_database()) as size_bytes");
    const logsRes = await pool.query("SELECT COUNT(*) FROM PatrolLogs");

    res.json({ 
      ok: true, 
      data: {
        sizeText: dbSizeRes.rows[0].size_text,
        sizeBytes: dbSizeRes.rows[0].size_bytes,
        totalLogs: parseInt(logsRes.rows[0].count)
      } 
    });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Endpoint untuk hapus data lebih dari 3 bulan
app.post("/api/system/cleanup", authenticateToken, async (req, res) => {
  try {
    if (!req.user.permissions.includes('all')) return res.status(403).json({ ok: false, error: "Akses ditolak" });

    // Hapus data PatrolLogs yang usianya lebih tua dari 3 bulan
    const deleteRes = await pool.query("DELETE FROM PatrolLogs WHERE Timestamp < NOW() - INTERVAL '3 months'");
    
    res.json({ ok: true, deletedRows: deleteRes.rowCount });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ==========================================
// REKAP LIST (MONTHLY REPORT)
// ==========================================
app.get("/api/reports/monthly", authenticateToken, async (req, res) => {
  const { month, year } = req.query;
  try {
    const query = `
      SELECT 
        TO_CHAR(l.Timestamp + INTERVAL '7 hours', 'DD/MM/YYYY') as tanggal,
        TO_CHAR(l.Timestamp + INTERVAL '7 hours', 'HH24:MI:SS') || ' WIB' as window,
        c.Name as lokasi,
        UPPER(l.Username) as petugas,
        l.Result as status
      FROM PatrolLogs l
      JOIN Checkpoints c ON l.CheckpointId = c.CheckpointId
      WHERE EXTRACT(MONTH FROM l.Timestamp + INTERVAL '7 hours') = $1
        AND EXTRACT(YEAR FROM l.Timestamp + INTERVAL '7 hours') = $2
      ORDER BY l.Timestamp ASC
    `;
    const result = await pool.query(query, [parseInt(month), parseInt(year)]);
    res.json({ ok: true, data: result.rows });
  } catch (err) { 
    res.status(500).json({ ok: false, error: err.message }); 
  }
});

// ==========================================
// MENGAMBIL PERIODE BULAN & TAHUN YANG TERSEDIA
// ==========================================
app.get("/api/reports/periods", authenticateToken, async (req, res) => {
  try {
    // Mencari kombinasi Bulan dan Tahun yang unik dari seluruh data log
    const query = `
      SELECT DISTINCT 
        EXTRACT(MONTH FROM Timestamp + INTERVAL '7 hours') as month, 
        EXTRACT(YEAR FROM Timestamp + INTERVAL '7 hours') as year 
      FROM PatrolLogs 
      ORDER BY year DESC, month DESC
    `;
    const result = await pool.query(query);
    res.json({ ok: true, data: result.rows });
  } catch (err) { 
    res.status(500).json({ ok: false, error: err.message }); 
  }
});


// ==========================================
// GET PATROL LOGS (ROLE-BASED & NAMA LOKASI)
// ==========================================
// ==========================================
// GET PATROL LOGS (ROLE-BASED & NAMA LOKASI)
// ==========================================
// ==========================================
// GET PATROL LOGS (ROLE-BASED, NAMA LOKASI & FILTER)
// ==========================================
// ==========================================
// GET PATROL LOGS (ROLE-BASED, NAMA LOKASI & FILTER)
// ==========================================
// ==========================================
// GET PATROL LOGS (ROLE-BASED, NAMA LOKASI & FILTER)
// ==========================================
app.get("/api/patrollogs", authenticateToken, async (req, res) => {
  try {
    let query = `
      SELECT 
        l.Timestamp as "timestamp",
        c.Name as "lokasi",
        l.BarcodeValue as "barcodevalue",
        l.Username as "username",
        l.ScanMethod as "metode",
        l.Result as "result",
        l.LogId as "logid"
      FROM PatrolLogs l
      LEFT JOIN Checkpoints c ON l.CheckpointId = c.CheckpointId
      WHERE 1=1 
    `;
    
    const params = [];
    let paramIndex = 1;

    // 1. FILTER ROLE / USERNAME
    if (!req.user.permissions.includes('all')) {
      query += ` AND LOWER(l.Username) = LOWER($${paramIndex++}) `;
      const uname = req.user.username || req.user.Username || req.user.name;
      params.push(uname);
    } else if (req.query.username) {
      query += ` AND LOWER(l.Username) = LOWER($${paramIndex++}) `;
      params.push(req.query.username);
    }

    // 2. FILTER TANGGAL (BARU)
    // Mencocokkan tanggal kalender secara presisi
    if (req.query.date) {
      query += ` AND (l.Timestamp + INTERVAL '7 hours')::date = $${paramIndex++} `;
      params.push(req.query.date);
    }

    // 3. FILTER LOKASI
    if (req.query.location) {
      query += ` AND c.Name = $${paramIndex++} `;
      params.push(req.query.location);
    }

    query += ` ORDER BY l.Timestamp DESC LIMIT 1000`;

    const result = await pool.query(query, params);
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==========================================
// API DELETE (USERS, CHECKPOINTS, LOGS)
// ==========================================

// 1. Hapus User
app.delete("/api/users/:id", authenticateToken, async (req, res) => {
  try {
    if (!req.user.permissions.includes('all')) return res.status(403).json({ ok: false, error: "Akses ditolak" });
    await pool.query("DELETE FROM Users WHERE UserId = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    // 23503 adalah kode error PostgreSQL untuk Foreign Key Violation
    if (err.code === '23503') return res.status(400).json({ ok: false, error: "Gagal: User ini memiliki riwayat scan. Solusi: Gunakan tombol Edit dan ubah status menjadi 'Non-Aktif'." });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 2. Hapus Checkpoint
app.delete("/api/checkpoints/:id", authenticateToken, async (req, res) => {
  try {
    if (!req.user.permissions.includes('all')) return res.status(403).json({ ok: false, error: "Akses ditolak" });
    await pool.query("DELETE FROM Checkpoints WHERE CheckpointId = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23503') return res.status(400).json({ ok: false, error: "Gagal: Lokasi ini memiliki riwayat scan. Solusi: Gunakan tombol Edit dan ubah status menjadi 'Inaktif'." });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 3. Hapus Patrol Log (Hanya Admin)
app.delete("/api/patrollogs/:id", authenticateToken, async (req, res) => {
  try {
    if (!req.user.permissions.includes('all')) return res.status(403).json({ ok: false, error: "Akses ditolak. Hanya Admin yang dapat menghapus riwayat." });
    await pool.query("DELETE FROM PatrolLogs WHERE LogId = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// --- STATIC SERVING ---
// ==========================================
// STATIC SERVING & ANTI-CACHE PWA
// ==========================================
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    // Beri perlindungan anti-cache HANYA untuk file HTML dan Service Worker
    if (filePath.endsWith('.html') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Rute fallback agar saat user refresh halaman /scan atau /dashboard tidak error 404
app.get(/^\/(?!api).*/, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

module.exports = app;



















