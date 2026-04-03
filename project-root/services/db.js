// ⚠️  RAILWAY DEPLOYMENT NOTE:
// SQLite data at data/sessions.db is on Railway's ephemeral filesystem.
// All user accounts and chat history are wiped on every redeploy.
// To persist data across deploys, migrate to Railway's PostgreSQL plugin
// or use a hosted SQLite service like Turso (https://turso.tech).
// See: https://docs.railway.com/reference/volumes
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '../data/sessions.db');
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ Could not connect to SQLite DB:', err.message);
    return;
  }
  // Enable WAL mode for better concurrency
  db.run('PRAGMA journal_mode=WAL');
  db.run('PRAGMA foreign_keys=ON');
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS Users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      passwordHash TEXT NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS ChatHistory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS PaperMeta (
      paperId TEXT NOT NULL,
      userId INTEGER NOT NULL,
      starred INTEGER DEFAULT 0,
      userNotes TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      collectionId TEXT DEFAULT NULL,
      summary TEXT DEFAULT '',
      lastOpenedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (paperId, userId)
    )`);
    // Migration: Add summary column if it doesn't exist (SQLite doesn't support IF NOT EXISTS in ALTER)
    db.run("ALTER TABLE PaperMeta ADD COLUMN summary TEXT DEFAULT ''", (err) => {
        if (err && !err.message.includes('duplicate column')) {
            console.warn('⚠️ PaperMeta migration warning:', err.message);
        }
    });

    db.run(`CREATE TABLE IF NOT EXISTS Collections (
      id TEXT PRIMARY KEY,
      userId INTEGER NOT NULL,
      name TEXT NOT NULL,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS PaperShares (
      shareToken TEXT PRIMARY KEY,
      paperId TEXT NOT NULL,
      ownerUserId INTEGER NOT NULL,
      permissions TEXT DEFAULT '{"canView":true,"canChat":true}',
      createdAt INTEGER DEFAULT (strftime('%s','now')),
      expiresAt INTEGER DEFAULT NULL,
      isRevoked INTEGER DEFAULT 0
    )`);
    // Performance indexes
    db.run(`CREATE INDEX IF NOT EXISTS idx_chathistory_sessionid ON ChatHistory(sessionId)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_papermeta_userid ON PaperMeta(userId)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_papershares_paperid ON PaperShares(paperId)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_collections_userid ON Collections(userId)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_users_email ON Users(email)`);
  });
  console.log('✅ SQLite DB initialized with WAL mode and all tables.');
});

module.exports = db;
