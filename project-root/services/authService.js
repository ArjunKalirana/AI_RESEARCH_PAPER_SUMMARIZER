const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const dbPath = path.join(__dirname, '../data/sessions.db');

const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ Could not connect to SQLite Session DB', err.message);
  } else {
    db.run(`
      CREATE TABLE IF NOT EXISTS Users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        passwordHash TEXT NOT NULL,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS PaperShares (
        shareToken TEXT PRIMARY KEY,
        paperId TEXT NOT NULL,
        ownerUserId INTEGER NOT NULL,
        permissions TEXT DEFAULT '{"canView":true,"canChat":true}',
        createdAt INTEGER DEFAULT (strftime('%s','now')),
        expiresAt INTEGER DEFAULT NULL,
        isRevoked INTEGER DEFAULT 0
      )
    `);
  }
});

async function registerUser(email, password) {
  return new Promise(async (resolve, reject) => {
    try {
      const passwordHash = await bcrypt.hash(password, 12);
      db.run(`INSERT INTO Users (email, passwordHash) VALUES (?, ?)`, [email, passwordHash], function (err) {
        if (err) {
          console.error(`❌ DB_REGISTER_ERROR [${email}]:`, err.message);
          if (err.message.includes('UNIQUE constraint failed')) {
            return reject(new Error('Email already exists'));
          }
          return reject(err);
        }
        console.log(`✅ DB_REGISTER_SUCCESS: Created user ${this.lastID} (${email})`);
        resolve({ userId: this.lastID, email });
      });
    } catch (e) {
      reject(e);
    }
  });
}

function loginUser(email, password) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT id, email, passwordHash FROM Users WHERE email = ?`, [email], async (err, row) => {
      if (err) {
        console.error(`❌ DB_LOGIN_QUERY_ERROR [${email}]:`, err.message);
        return reject(err);
      }
      if (!row) {
        console.warn(`⚠️  DB_LOGIN_NOT_FOUND: User ${email} not found.`);
        return reject(new Error('Invalid email or password'));
      }
      
      const isValid = await bcrypt.compare(password, row.passwordHash);
      if (!isValid) {
        console.warn(`⚠️  DB_LOGIN_INVALID_PASSWORD: Incorrect password for ${email}.`);
        return reject(new Error('Invalid email or password'));
      }
      
      console.log(`✅ DB_LOGIN_SUCCESS: User ${row.id} (${email}) logged in.`);
      resolve({ userId: row.id, email: row.email });
    });
  });
}

function signToken(userId, email) {
  return jwt.sign({ userId, email }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

function createShareToken(paperId, ownerUserId, days = 7) {
  return new Promise((resolve, reject) => {
    const crypto = require('crypto');
    const token = crypto.randomUUID();
    const expiresAt = days ? Math.floor(Date.now() / 1000) + (days * 24 * 60 * 60) : null;

    db.run(
      `INSERT INTO PaperShares (shareToken, paperId, ownerUserId, expiresAt) VALUES (?, ?, ?, ?)`,
      [token, paperId, ownerUserId, expiresAt],
      (err) => {
        if (err) return reject(err);
        resolve(token);
      }
    );
  });
}

function revokeShareTokens(paperId, ownerUserId) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE PaperShares SET isRevoked = 1 WHERE paperId = ? AND ownerUserId = ?`,
      [paperId, ownerUserId],
      function (err) {
        if (err) return reject(err);
        resolve(this.changes);
      }
    );
  });
}

function getShareToken(token) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM PaperShares WHERE shareToken = ?`,
      [token],
      (err, row) => {
        if (err) return reject(err);
        resolve(row);
      }
    );
  });
}

module.exports = {
  registerUser,
  loginUser,
  signToken,
  verifyToken,
  createShareToken,
  revokeShareTokens,
  getShareToken
};
