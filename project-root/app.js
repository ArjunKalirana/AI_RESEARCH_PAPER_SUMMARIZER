require('dotenv').config({ quiet: true });

// Validate critical env vars on startup
const REQUIRED_ENV = ['GROQ_API_KEY', 'NEO4J_URL', 'NEO4J_PASSWORD', 'FAISS_URL', 'JWT_SECRET'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.warn(`⚠️  Missing environment variables: ${missing.join(', ')} — some features may not work correctly.`);
}
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');

const uploadRoutes = require('./routes/upload.route');
const summaryRoutes = require('./routes/summary.route');
const askRoutes = require('./routes/ask.route');
const compareRoutes = require('./routes/compare.route');
const libraryRoutes = require('./routes/library.route');
const litreviewRoutes = require('./routes/litreview.route');
const exportRoutes = require('./routes/export.route');
const authRoutes = require('./routes/auth.route');

const app = express();
app.set('trust proxy', 1);

const server = http.createServer(app);
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : null; // null = allow all origins (Railway public URL varies per deploy)

const io = new Server(server, {
  cors: {
    origin: allowedOrigins || '*',
    methods: ['GET', 'POST'],
    credentials: true,
  }
});

// Attach io to app for use in controllers
app.set('io', io);

io.on('connection', (socket) => {
  console.log(`🔌 New client connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: allowedOrigins || '*',
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Request Logger diagnostic
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Robust Frontend Path Resolution
const possiblePaths = [
  path.resolve(__dirname, 'frontend'),
  path.resolve(__dirname, '../frontend'),
  path.resolve(process.cwd(), 'frontend'),
  path.resolve(process.cwd(), 'project-root', 'frontend')
];

let frontendPath = null;
for (const p of possiblePaths) {
  if (fs.existsSync(p)) {
    frontendPath = p;
    console.log("✅ Frontend folder found at:", frontendPath);
    break;
  }
}

if (!frontendPath) {
  console.error("❌ Frontend folder NOT found in any expected location");
}

// Auto-build CSS if dist/output.css is missing (safety net for failed build phases)
if (frontendPath) {
  const cssOutputPath = path.join(frontendPath, 'dist', 'output.css');
  if (!fs.existsSync(cssOutputPath)) {
    console.warn('⚠️  dist/output.css not found — attempting emergency CSS build...');
    try {
      const { execSync } = require('child_process');
      fs.mkdirSync(path.join(frontendPath, 'dist'), { recursive: true });
      execSync('npm run build', {
        cwd: path.resolve(__dirname),
        stdio: 'pipe',
        timeout: 60000
      });
      console.log('✅ Emergency CSS build completed.');
    } catch (buildErr) {
      console.error('❌ Emergency CSS build failed:', buildErr.message);
      console.error('Pages will be unstyled. Check that tailwindcss is installed.');
    }
  } else {
    console.log('✅ dist/output.css found — CSS ready.');
  }
}

// Serve compiled CSS first to prevent shadowing
if (frontendPath) {
  app.use('/dist', express.static(path.join(frontendPath, 'dist')));
  app.use(express.static(frontendPath));
}

// Return proper 404 for missing static assets — never return HTML for .css/.js files
app.use((req, res, next) => {
  const ext = path.extname(req.path);
  const staticExts = ['.css', '.js', '.png', '.jpg', '.ico', '.svg', '.woff', '.woff2', '.ttf'];
  if (staticExts.includes(ext)) {
    return res.status(404).type(ext.slice(1)).send('');
  }
  next();
});

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

// Shared Paper Public Route
app.get('/shared/:token', (req, res) => {
    const sharedPath = path.join(frontendPath, 'shared.html');
    if (fs.existsSync(sharedPath)) {
        res.sendFile(sharedPath);
    } else {
        res.status(404).send("shared.html NOT FOUND");
    }
});

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
app.use('/api/auth', authRoutes);
app.use('/api', uploadRoutes);
app.use('/api', summaryRoutes);
app.use('/api', askRoutes);
app.use('/api', compareRoutes);
app.use('/api', libraryRoutes);
app.use('/api', litreviewRoutes);
app.use('/api', exportRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!', details: err.message });
});

const { rebuildIndicesFromDisk } = require('./services/faissService');

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    
    // Initial rebuild of FAISS indices on startup to handle ephemeral filesystem loss
    setTimeout(() => {
      rebuildIndicesFromDisk().catch(err => console.error("❌ FAISS Startup Rebuild Failed:", err.message));
    }, 5000);
});
