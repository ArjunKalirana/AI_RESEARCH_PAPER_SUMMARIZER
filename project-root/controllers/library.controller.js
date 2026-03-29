const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { runQuery } = require('../services/neo4j.service');

const DATA_DIR = path.join(__dirname, '../data/processed_papers');
const FAISS_URL = process.env.FAISS_URL || "http://localhost:8001";

async function getLibrary(req, res) {
  try {
    const query = `
      MATCH (p:ResearchPaper)
      OPTIONAL MATCH (p)-[:WRITTEN_BY]->(a:Author)
      RETURN p.paperId as paperId, 
             p.title as title, 
             p.year as year, 
             collect(a.authorName) as authors
      ORDER BY p.title
    `;
    const result = await runQuery(query);
    const papers = result.records.map(record => {
      const paperId = record.get('paperId');
      const jsonPath = path.join(DATA_DIR, `${paperId}.json`);
      const hasLocalData = fs.existsSync(jsonPath);
      
      return {
        paperId,
        title: record.get('title'),
        year: record.get('year'),
        authors: record.get('authors'),
        hasLocalData,
        status: hasLocalData ? 'ready' : 'needs_reindex'
      };
    });
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

module.exports = { getLibrary, deletePaper, reindexPaper };
