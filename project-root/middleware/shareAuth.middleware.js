const { verifyToken, getShareToken } = require('../services/authService');
const rateLimit = require('express-rate-limit');

const guestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 50, 
    message: { error: 'Rate limit exceeded for this shared link. Please try again later.' },
    keyGenerator: (req) => req.ip
});

async function shareAuth(req, res, next) {
    // 1. Standard JWT Auth
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        try {
            const decoded = verifyToken(token);
            req.user = decoded; // { userId, email }
            req.isGuest = false;
            return next();
        } catch (error) {
            // Logically fallthrough to share token check if JWT is invalid
        }
    }

    // 2. Share Token Guest Auth
    const shareToken = req.query.shareToken || req.headers['x-share-token'];
    if (shareToken) {
        try {
            const share = await getShareToken(shareToken);
            if (!share) return res.status(403).json({ error: 'Share link invalid or not found.' });
            
            if (share.isRevoked === 1) return res.status(403).json({ error: 'Share link has been revoked.' });
            if (share.expiresAt && Math.floor(Date.now() / 1000) > share.expiresAt) {
                return res.status(403).json({ error: 'Share link has expired.' });
            }

            req.user = null; // Do NOT construct fake users to avoid write hazards
            req.isGuest = true;
            req.shareContext = {
                paperId: share.paperId,
                ownerUserId: share.ownerUserId,
                permissions: JSON.parse(share.permissions || '{}')
            };
            
            // Invoke rate limiter explicitly for guests
            return guestLimiter(req, res, next);
        } catch(e) {
            return res.status(403).json({ error: 'Share token processing error.' });
        }
    }

    return res.status(401).json({ error: 'Unauthorized. No active session or valid share link found.' });
}

module.exports = shareAuth;
