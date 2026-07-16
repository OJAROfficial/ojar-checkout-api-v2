/**
 * List Abandoned Checkouts (admin app)
 * GET /api/abandoned-list?status=pending&search=&from=&to=&limit=50&offset=0
 *
 * Returns rows from Supabase for the embedded admin UI.
 * Protected by a shared token so the endpoint is not publicly readable.
 */

const { listAbandonedCheckouts } = require('./utils/supabase');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Token');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    // Simple shared-token auth (set ADMIN_APP_TOKEN in Vercel)
    const expected = process.env.ADMIN_APP_TOKEN;
    const provided = req.headers['x-app-token'] || req.query.token;
    if (!expected || provided !== expected) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const { status, search, from, to, limit, offset } = req.query;

        const result = await listAbandonedCheckouts({
            status: status || '',
            search: search || '',
            from: from || '',
            to: to || '',
            limit: limit || 50,
            offset: offset || 0,
        });

        return res.status(200).json({
            rows: result.rows,
            total: result.total,
            limit: parseInt(limit, 10) || 50,
            offset: parseInt(offset, 10) || 0,
        });
    } catch (error) {
        console.error('[abandoned-list] error:', error);
        return res.status(500).json({ error: 'Failed to fetch', message: error.message });
    }
};
