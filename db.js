const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = process.env.VERCEL ? path.join('/tmp', 'translator.db') : path.join(__dirname, 'translator.db');
const db = new sqlite3.Database(dbPath);

// Helper functions to wrap sqlite3 with Promises
const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
};

const dbGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const dbAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

// Initialize the database tables
const initDatabase = async () => {
  // 1. API Keys table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_value TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'active', -- 'active', 'invalid', 'rate_limited'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 2. Translation Jobs table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS translation_jobs (
      job_id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      original_format TEXT NOT NULL, -- 'txt', 'html', 'docx'
      target_lang TEXT NOT NULL,      -- 'en', 'ja', 'zh'
      status TEXT DEFAULT 'pending',  -- 'pending', 'processing', 'completed', 'failed', 'paused'
      total_chunks INTEGER DEFAULT 0,
      completed_chunks INTEGER DEFAULT 0,
      output_filepath TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 3. Job Chunks table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS job_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      original_content TEXT NOT NULL, -- text or HTML snippet
      translated_content TEXT,
      status TEXT DEFAULT 'pending',   -- 'pending', 'completed', 'failed'
      error_message TEXT,
      FOREIGN KEY(job_id) REFERENCES translation_jobs(job_id) ON DELETE CASCADE
    )
  `);

  // 4. Job Logs table
  await dbRun(`
    CREATE TABLE IF NOT EXISTS job_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      message TEXT NOT NULL,
      level TEXT DEFAULT 'info',       -- 'info', 'warn', 'error'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(job_id) REFERENCES translation_jobs(job_id) ON DELETE CASCADE
    )
  `);
};

// Log helper
const logJobMessage = async (jobId, message, level = 'info') => {
  console.log(`[Job ${jobId}][${level.toUpperCase()}] ${message}`);
  await dbRun(
    'INSERT INTO job_logs (job_id, message, level) VALUES (?, ?, ?)',
    [jobId, message, level]
  );
};

// Initialize DB immediately
initDatabase().catch(err => {
  console.error('Failed to initialize database:', err);
});

module.exports = {
  dbRun,
  dbGet,
  dbAll,
  logJobMessage
};
