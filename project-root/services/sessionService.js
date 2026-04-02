const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Initialize database
const dbPath = path.join(__dirname, '../data/sessions.db');

// Ensure data directory exists before creating the SQLite DB
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ Could not connect to SQLite Session DB', err.message);
  } else {
    // Create Table if it doesn't exist
    db.run(`
      CREATE TABLE IF NOT EXISTS ChatHistory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT,
        role TEXT,
        content TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }
});

const MAX_HISTORY_LENGTH = 10; // Stores last 5 Q&A pairs

/**
 * Retrieves the chat history for a given paper/session, ensuring it stays within the sliding window limit.
 * @param {string} sessionId - The unique identifier (e.g. paperId)
 * @returns {Promise<Array>} Array of message objects { role: 'user' | 'assistant', content: string }
 */
function getChatHistory(sessionId, userId) {
  const scopedId = `userId::${userId}::sessionId::${sessionId}`;
  return new Promise((resolve, reject) => {
    // We order by timestamp DESC to get the latest messages, then limit by MAX, then reverse them
    // so they are chronological for the LLM.
    const query = `
      SELECT role, content 
      FROM ChatHistory 
      WHERE sessionId = ? 
      ORDER BY timestamp DESC 
      LIMIT ?
    `;

    db.all(query, [scopedId, MAX_HISTORY_LENGTH], (err, rows) => {
      if (err) {
        console.error('Error fetching chat history:', err.message);
        return reject(err);
      }
      
      // Order from oldest to newest based on the retrieved window
      resolve(rows.reverse().map(row => ({
        role: row.role,
        content: row.content
      })));
    });
  });
}

/**
 * Appends a new message to the chat history, automatically pruning old messages to maintain the sliding window.
 * @param {string} sessionId - The unique identifier (e.g. paperId)
 * @param {string} role - 'user' or 'assistant'
 * @param {string} content - the message text
 */
function addMessageToHistory(sessionId, userId, role, content) {
  const scopedId = `userId::${userId}::sessionId::${sessionId}`;
  return new Promise((resolve, reject) => {
    const insertQuery = `INSERT INTO ChatHistory (sessionId, role, content) VALUES (?, ?, ?)`;
    
    db.run(insertQuery, [scopedId, role, content], function(err) {
      if (err) {
        console.error('Error inserting message:', err.message);
        return reject(err);
      }

      // Cleanup: Delete excess records to maintain sliding window boundary
      const cleanupQuery = `
        DELETE FROM ChatHistory 
        WHERE id NOT IN (
          SELECT id FROM ChatHistory 
          WHERE sessionId = ? 
          ORDER BY timestamp DESC 
          LIMIT ?
        )
        AND sessionId = ?
      `;

      db.run(cleanupQuery, [scopedId, MAX_HISTORY_LENGTH, scopedId], (cleanupErr) => {
        if (cleanupErr) {
          console.error('Error pruning chat history:', cleanupErr.message);
        }
        resolve(this.lastID);
      });
    });
  });
}

/**
 * Clears the chat history for a specific session.
 * @param {string} sessionId 
 */
function clearChatHistory(sessionId, userId) {
  const scopedId = `userId::${userId}::sessionId::${sessionId}`;
  return new Promise((resolve, reject) => {
    const deleteQuery = `DELETE FROM ChatHistory WHERE sessionId = ?`;
    db.run(deleteQuery, [scopedId], (err) => {
      if (err) return reject(err);
      resolve(true);
    });
  });
}

module.exports = {
  getChatHistory,
  addMessageToHistory,
  clearChatHistory
};
