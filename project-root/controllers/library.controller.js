const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const { runQuery } = require('../services/neo4j.service');
const { getPaperMeta, getAllUserPaperMeta, updatePaperMeta, getCollections, createCollection } = require('../services/libraryMetaService');
const { createShareToken, revokeShareTokens, getShareToken } = require('../services/authService');

const DATA_DIR = path.join(__dirname, '../data/processed_papers');
const FAISS_URL = process.env.FAISS_URL || "http://localhost:8001";

async function getLibrary(req, res) {
  try {
    const query = `
      MATCH (p:ResearchPaper {userId: $userId})
      OPTIONAL MATCH (p)-[:WRITTEN_BY]->(a:Author)
      RETURN p.paperId as paperId, 
             p.title as title, 
             p.year as year, 
             collect(a.authorName) as authors
      ORDER BY p.title
    `;
    const result = await runQuery(query, { userId: req.user.userId });
    
    const userMeta = await getAllUserPaperMeta(req.user.userId);
    const metaMap = {};
    userMeta.forEach(m => metaMap[m.paperId] = m);

    const papers = result.records.map(record => {
      const paperId = record.get('paperId');
      const jsonPath = path.join(DATA_DIR, `${paperId}.json`);
      const hasLocalData = fs.existsSync(jsonPath);
      let isValidUser = false;
      if (hasLocalData) {
        try {
          const paper = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
          isValidUser = paper.userId === req.user.userId;
        } catch(e) {}
      }

      if (hasLocalData && !isValidUser) return null;
      
      const meta = metaMap[paperId] || { starred: 0, userNotes: '', tags: [], collectionId: null, lastOpenedAt: null };
      
      return {
        paperId,
        title: record.get('title'),
        year: record.get('year'),
        authors: record.get('authors'),
        hasLocalData,
        status: hasLocalData ? 'ready' : 'needs_reindex',
        ...meta
      };
    }).filter(Boolean);
    res.json(papers);
  } catch (error) {
    console.error('[Library] Error fetching papers:', error);
    res.status(500).json({ error: 'Failed to fetch library' });
  }
}

async function deletePaper(req, res) {
  const { paperId } = req.params;
  try {
    // 1. Delete from Neo4j
    const deleteQuery = `
      MATCH (p:ResearchPaper {paperId: $paperId})
      DETACH DELETE p
    `;
    await runQuery(deleteQuery, { paperId });

    // 2. Delete local processed JSON
    const jsonPath = path.join(DATA_DIR, `${paperId}.json`);
    if (fs.existsSync(jsonPath)) {
      const paperData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      if (paperData.userId !== req.user.userId) {
        return res.status(403).json({ error: 'Forbidden: You do not own this paper.' });
      }
      fs.unlinkSync(jsonPath);
    }

    // 3. Call FAISS delete
    try {
      await axios.delete(`${FAISS_URL}/delete-index/${paperId}`, { timeout: 5000 });
    } catch (faissErr) {
      console.warn(`[Library] Failed to delete FAISS index for ${paperId}:`, faissErr.message);
    }

    res.json({ success: true, message: `Paper ${paperId} deleted successfully.` });
  } catch (error) {
    console.error('[Library] Error deleting paper:', error);
    res.status(500).json({ error: 'Failed to delete paper' });
  }
}

async function reindexPaper(req, res) {
  const { paperId } = req.params;
  const jsonPath = path.join(DATA_DIR, `${paperId}.json`);
  
  if (!fs.existsSync(jsonPath)) {
    return res.status(404).json({ 
      error: 'Paper data not found on disk. Please re-upload the original PDF.',
      needsReupload: true 
    });
  }
  
  try {
    const paper = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    if (paper.userId !== req.user.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!paper.chunks || paper.chunks.length === 0) {
      return res.status(400).json({ error: 'Paper has no chunks to index.' });
    }
    
    await axios.post(`${FAISS_URL}/index`, {
      index_id: paperId,
      chunks: paper.chunks
    }, { timeout: 30000 });
    
    res.json({ success: true, message: `Re-indexed ${paper.chunks.length} chunks for "${paper.title}"` });
  } catch (err) {
    console.error('[Reindex] Error:', err.message);
    res.status(500).json({ error: 'FAISS re-indexing failed: ' + err.message });
  }
}

async function toggleStar(req, res) {
  const { paperId } = req.params;
  try {
    const meta = await getPaperMeta(paperId, req.user.userId) || { starred: 0 };
    const newStarred = meta.starred ? 0 : 1;
    await updatePaperMeta(paperId, req.user.userId, { starred: newStarred });
    res.json({ success: true, starred: newStarred });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

async function updateNotes(req, res) {
  const { paperId } = req.params;
  const { notes } = req.body;
  try {
    await updatePaperMeta(paperId, req.user.userId, { userNotes: notes });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

async function searchLibrary(req, res) {
  const q = (req.query.q || '').toLowerCase();
  try {
    const query = `
      MATCH (p:ResearchPaper {userId: $userId})
      OPTIONAL MATCH (p)-[:WRITTEN_BY]->(a:Author)
      RETURN p.paperId as paperId, 
             p.title as title, 
             p.year as year, 
             collect(a.authorName) as authors
    `;
    const result = await runQuery(query, { userId: req.user.userId });
    const userMeta = await getAllUserPaperMeta(req.user.userId);
    const metaMap = {};
    userMeta.forEach(m => metaMap[m.paperId] = m);

    let papers = result.records.map(record => {
      const paperId = record.get('paperId');
      const title = record.get('title') || '';
      const authors = record.get('authors') || [];
      const meta = metaMap[paperId] || { starred: 0, userNotes: '', tags: [], collectionId: null, lastOpenedAt: null };
      const jsonPath = path.join(DATA_DIR, `${paperId}.json`);
      const hasLocalData = fs.existsSync(jsonPath);

      return {
        paperId, title, year: record.get('year'), authors,
        hasLocalData, status: hasLocalData ? 'ready' : 'needs_reindex',
        ...meta
      };
    }).filter(p => p.hasLocalData);

    if (q) {
      papers = papers.filter(p => 
        p.title.toLowerCase().includes(q) || 
        p.authors.some(a => a.toLowerCase().includes(q)) || 
        p.tags.some(t => t.toLowerCase().includes(q))
      );
    }

    res.json(papers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

async function listCollections(req, res) {
  try {
    const collections = await getCollections(req.user.userId);
    res.json(collections);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

async function createCollectionEntry(req, res) {
  try {
    const id = crypto.randomUUID();
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const cols = await createCollection(id, req.user.userId, name);
    res.json(cols);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

async function updateCollection(req, res) {
  const { paperId } = req.params;
  const { collectionId } = req.body;
  try {
    await updatePaperMeta(paperId, req.user.userId, { collectionId });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

async function createShare(req, res) {
  const { paperId } = req.params;
  const jsonPath = path.join(DATA_DIR, `${paperId}.json`);
  if (!fs.existsSync(jsonPath)) return res.status(404).json({ error: 'Paper not found.' });

  try {
    const paper = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (paper.userId !== req.user.userId) return res.status(403).json({ error: 'Forbidden' });

    const token = await createShareToken(paperId, req.user.userId, 7);
    const shareUrl = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers.host}/shared/${token}`;
    
    res.json({ success: true, shareUrl, token });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

async function revokeShare(req, res) {
  const { paperId } = req.params;
  try {
    const changes = await revokeShareTokens(paperId, req.user.userId);
    res.json({ success: true, changes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

async function getPublicShareData(req, res) {
  const { token } = req.params;
  try {
    const share = await getShareToken(token);
    if (!share) return res.status(404).json({ error: 'Share link invalid or not found.' });
    if (share.isRevoked === 1) return res.status(403).json({ error: 'Share link has been revoked.' });
    if (share.expiresAt && Math.floor(Date.now() / 1000) > share.expiresAt) {
      return res.status(403).json({ error: 'Share link has expired.' });
    }

    const jsonPath = path.join(DATA_DIR, `${share.paperId}.json`);
    if (!fs.existsSync(jsonPath)) return res.status(404).json({ error: 'Paper data no longer exists.' });

    const paper = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    
    let abstractPreview = "No abstract available.";
    if (paper.chunks && paper.chunks.length > 0) {
      abstractPreview = paper.chunks[0].chunkText.substring(0, 500) + '...';
    }

    res.json({ 
      title: paper.title,
      authors: paper.authors,
      year: paper.year,
      abstractPreview,
      permissions: JSON.parse(share.permissions || '{}')
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to process share data.' });
  }
}

module.exports = { 
  getLibrary, deletePaper, reindexPaper, 
  toggleStar, updateNotes, searchLibrary, 
  listCollections, createCollectionEntry, updateCollection,
  createShare, revokeShare, getPublicShareData
};
