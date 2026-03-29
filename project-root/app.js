require('dotenv').config({ quiet: true });

// Validate critical env vars on startup
const REQUIRED_ENV = ['GROQ_API_KEY', 'NEO4J_URL', 'NEO4J_PASSWORD', 'FAISS_URL'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.warn(`⚠️  Missing environment variables: ${missing.join(', ')} — some features may not work correctly.`);
}
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const uploadRoutes = require('./routes/upload.route');
const summaryRoutes = require('./routes/summary.route');
const askRoutes = require('./routes/ask.route');
const compareRoutes = require('./routes/compare.route');
const libraryRoutes = require('./routes/library.route');
const litreviewRoutes = require('./routes/litreview.route');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request Logger diagnostic
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Diagnostic: Check if frontend exists in the container
const frontendPath = path.resolve(__dirname, 'frontend');
if (fs.existsSync(frontendPath)) {
    console.log("✅ Frontend folder found at (resolved):", frontendPath);
    console.log("📂 Content:", fs.readdirSync(frontendPath));
} else {
    console.error("❌ Frontend folder NOT found at (resolved):", frontendPath);
}

// Serve frontend static files
app.use(express.static(frontendPath));

// Explicit Root Handler
app.get('/', (req, res) => {
    const indexPath = path.join(frontendPath, 'upload.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send("upload.html NOT FOUND in " + frontendPath);
    }
});

// Dummy Favicon handler to stop 404 logs
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ── Health Check (Railway monitoring) ───────────────────────────────────────
app.get('/health', async (req, res) => {
  // Always return 200 — Railway healthcheck only needs to know Node.js is alive.
  // Service connectivity is informational only, not a reason to kill the container.
  const checks = { 
    status: 'ok', 
    timestamp: new Date().toISOString(), 
    uptime: Math.floor(process.uptime()) + 's',
    services: {} 
  };

  // Check Neo4j — non-blocking, don't fail health if it's slow
  try {
    const { runQuery } = require('./services/neo4j.service');
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('timeout')), 2000)
    );
    await Promise.race([runQuery('RETURN 1'), timeoutPromise]);
    checks.services.neo4j = 'connected';
  } catch (e) {
    checks.services.neo4j = 'degraded: ' + e.message;
    checks.status = 'degraded'; // informational only — still returns 200
  }

  // Check FAISS — non-blocking
  try {
    const axios = require('axios');
    const FAISS_URL = process.env.FAISS_URL || 'http://localhost:8001';
    await axios.get(`${FAISS_URL}/health`, { timeout: 2000 });
    checks.services.faiss = 'connected';
  } catch (e) {
    checks.services.faiss = 'degraded: ' + e.message;
    checks.status = 'degraded';
  }

  // ALWAYS return 200 — Railway needs this for stability
  res.status(200).json(checks);
});

// API Routes
app.use('/api', uploadRoutes);
app.use('/api', summaryRoutes);
app.use('/api', askRoutes);
app.use('/api', compareRoutes);
app.use('/api', libraryRoutes);
app.use('/api', litreviewRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!', details: err.message });
});

const { rebuildIndicesFromDisk } = require('./services/faissService');

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    
    // Initial rebuild of FAISS indices on startup to handle ephemeral filesystem loss
    setTimeout(() => {
      rebuildIndicesFromDisk().catch(err => console.error("❌ FAISS Startup Rebuild Failed:", err.message));
    }, 5000);
});
