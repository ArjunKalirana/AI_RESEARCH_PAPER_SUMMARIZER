const db = require('./db');

function getPaperMeta(paperId, userId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM PaperMeta WHERE paperId = ? AND userId = ?', [paperId, userId], (err, row) => {
      if (err) return reject(err);
      if (row && row.tags) {
          try { row.tags = JSON.parse(row.tags); } catch(e) { row.tags = []; }
      }
      resolve(row || null);
    });
  });
}

function getAllUserPaperMeta(userId) {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM PaperMeta WHERE userId = ?', [userId], (err, rows) => {
      if (err) return reject(err);
      rows.forEach(row => {
        try { row.tags = JSON.parse(row.tags); } catch(e) { row.tags = []; }
      });
      resolve(rows || []);
    });
  });
}

function updatePaperMeta(paperId, userId, updateFields) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM PaperMeta WHERE paperId = ? AND userId = ?', [paperId, userId], (err, existing) => {
      if (err) return reject(err);

      if (!existing) {
        const record = {
          paperId, userId,
          starred: updateFields.starred !== undefined ? updateFields.starred : 0,
          userNotes: updateFields.userNotes !== undefined ? updateFields.userNotes : '',
          tags: updateFields.tags !== undefined ? (typeof updateFields.tags === 'string' ? updateFields.tags : JSON.stringify(updateFields.tags)) : '[]',
          collectionId: updateFields.collectionId !== undefined ? updateFields.collectionId : null
        };
        db.run(
          'INSERT INTO PaperMeta (paperId, userId, starred, userNotes, tags, collectionId) VALUES (?, ?, ?, ?, ?, ?)',
          [record.paperId, record.userId, record.starred, record.userNotes, record.tags, record.collectionId],
          function(err) {
            if (err) return reject(err);
            resolve({ ...record, tags: JSON.parse(record.tags) });
          }
        );
      } else {
        const starred = updateFields.starred !== undefined ? updateFields.starred : existing.starred;
        const userNotes = updateFields.userNotes !== undefined ? updateFields.userNotes : existing.userNotes;
        const tags = updateFields.tags !== undefined ? (typeof updateFields.tags === 'string' ? updateFields.tags : JSON.stringify(updateFields.tags)) : existing.tags;
        const collectionId = updateFields.collectionId !== undefined ? updateFields.collectionId : existing.collectionId;
        const lastOpenedAt = updateFields.lastOpenedAt !== undefined ? updateFields.lastOpenedAt : existing.lastOpenedAt;

        db.run(
          'UPDATE PaperMeta SET starred = ?, userNotes = ?, tags = ?, collectionId = ?, lastOpenedAt = ? WHERE paperId = ? AND userId = ?',
          [starred, userNotes, tags, collectionId, lastOpenedAt, paperId, userId],
          function(err) {
            if (err) return reject(err);
            resolve({ paperId, userId, starred, userNotes, tags: typeof tags === 'string' ? JSON.parse(tags) : tags, collectionId, lastOpenedAt });
          }
        );
      }
    });
  });
}

function getCollections(userId) {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM Collections WHERE userId = ? ORDER BY createdAt DESC', [userId], (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function createCollection(id, userId, name) {
  return new Promise((resolve, reject) => {
    db.run('INSERT INTO Collections (id, userId, name) VALUES (?, ?, ?)', [id, userId, name], function(err) {
      if (err) return reject(err);
      resolve({ id, userId, name });
    });
  });
}

module.exports = {
  db,
  getPaperMeta,
  getAllUserPaperMeta,
  updatePaperMeta,
  getCollections,
  createCollection
};
