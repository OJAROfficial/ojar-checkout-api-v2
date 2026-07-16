/**
 * Export Abandoned Checkouts as CSV (admin app)
 * GET /api/abandoned-export?status=pending&search=&from=&to=
 *
 * Streams a CSV download of the filtered rows (up to 1000).
 */

const { listAbandonedCheckouts } = require('./utils/supabase');

/** Escape a value for CSV: wrap in quotes, double any inner quotes. */
function csvCell(value) {
    if (value === null || value === undefined) return '""';
    const str = String(value).replace(/"/g, '""');
    return `"${str}"`;
}

/** Flatten cart_items JSON into a readable single cell. */
function formatCartItems(cartItems) {
    if (!Array.isArray(cartItems)) return '';
    return cartItems
        .map(i => `${i.title || i.handle || 'item'} x${i.quantity || 1}`)
        .join(' | ');
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Token');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const expected = process.env.ADMIN_APP_TOKEN;
    const provided = req.headers['x-app-token'] || req.query.token;
    if (!expected || provided !== expected) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const { status, search, from, to } = req.query;

        const { rows } = await listAbandonedCheckouts({
            status: status || '',
            search: search || '',
            from: from || '',
            to: to || '',
            limit: 1000,
            offset: 0,
        });

        const header = [
            'Email',
            'Cart Items',
            'Cart Total',
            'Currency',
            'Status',
            'Checkout ID',
            'Created At',
        ].map(csvCell).join(',');

        const lines = rows.map(r => [
            csvCell(r.email),
            csvCell(formatCartItems(r.cart_items)),
            csvCell(r.cart_total),
            csvCell(r.currency),
            csvCell(r.status),
            csvCell(r.checkout_id),
            csvCell(r.created_at),
        ].join(','));

        // BOM so Excel opens UTF-8 (Arabic product names) correctly
        const csv = '\uFEFF' + [header, ...lines].join('\r\n');

        const stamp = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="abandoned-checkouts-${stamp}.csv"`);
        return res.status(200).send(csv);
    } catch (error) {
        console.error('[abandoned-export] error:', error);
        return res.status(500).json({ error: 'Failed to export', message: error.message });
    }
};
