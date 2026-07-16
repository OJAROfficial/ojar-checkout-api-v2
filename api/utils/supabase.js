/**
 * Supabase client for abandoned checkout tracking
 * Uses the REST API directly (no SDK dependency needed).
 *
 * Env vars required in Vercel:
 *   SUPABASE_URL         e.g. https://xxxxx.supabase.co
 *   SUPABASE_SECRET_KEY  the secret (service) key — server-side only, never expose
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const TABLE = 'abandoned_checkouts';

function isConfigured() {
    return Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY);
}

function headers() {
    return {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    };
}

/**
 * Insert a pending abandoned-checkout row.
 * Returns the new row id, or null on any failure (never throws — must not block checkout).
 */
async function createAbandonedCheckout({ email, cartItems, cartTotal, currency }) {
    if (!isConfigured()) {
        console.warn('[Supabase] Not configured, skipping abandoned checkout insert');
        return null;
    }
    if (!email) {
        console.log('[Supabase] No email provided, skipping abandoned checkout insert');
        return null;
    }

    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, {
            method: 'POST',
            headers: { ...headers(), Prefer: 'return=representation' },
            body: JSON.stringify({
                email: email,
                cart_items: cartItems || [],
                cart_total: cartTotal || 0,
                currency: currency || 'USD',
                status: 'pending',
            }),
        });

        if (!res.ok) {
            const text = await res.text();
            console.warn('[Supabase] Insert failed:', res.status, text);
            return null;
        }

        const rows = await res.json();
        const id = rows && rows[0] && rows[0].id ? rows[0].id : null;
        console.log('[Supabase] Abandoned checkout row created:', id);
        return id;
    } catch (err) {
        console.warn('[Supabase] Insert error (non-blocking):', err.message);
        return null;
    }
}

/**
 * Attach the Stripe checkout session id to an existing row.
 */
async function attachCheckoutId(rowId, checkoutId) {
    if (!isConfigured() || !rowId || !checkoutId) return false;

    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.${rowId}`, {
            method: 'PATCH',
            headers: headers(),
            body: JSON.stringify({ checkout_id: checkoutId }),
        });
        if (!res.ok) {
            console.warn('[Supabase] attachCheckoutId failed:', res.status, await res.text());
            return false;
        }
        console.log('[Supabase] checkout_id attached to row:', rowId);
        return true;
    } catch (err) {
        console.warn('[Supabase] attachCheckoutId error:', err.message);
        return false;
    }
}

/**
 * Mark a checkout as completed once payment succeeds, so no recovery email is sent.
 * Matches by Stripe session id (checkout_id).
 */
async function markCheckoutCompleted(checkoutId) {
    if (!isConfigured() || !checkoutId) return false;

    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?checkout_id=eq.${checkoutId}`, {
            method: 'PATCH',
            headers: headers(),
            body: JSON.stringify({ status: 'completed' }),
        });
        if (!res.ok) {
            console.warn('[Supabase] markCheckoutCompleted failed:', res.status, await res.text());
            return false;
        }
        console.log('[Supabase] Checkout marked completed:', checkoutId);
        return true;
    } catch (err) {
        console.warn('[Supabase] markCheckoutCompleted error:', err.message);
        return false;
    }
}

/**
 * Fetch abandoned checkout rows with optional filters (for the admin app).
 * @param {object} opts
 *   status - 'pending' | 'completed' | 'recovered' | '' (all)
 *   search - free text matched against email
 *   from   - ISO date string (created_at >= from)
 *   to     - ISO date string (created_at <= to)
 *   limit  - page size (default 50, max 1000)
 *   offset - pagination offset
 * @returns {{ rows: Array, total: number }}
 */
async function listAbandonedCheckouts(opts = {}) {
    if (!isConfigured()) {
        console.warn('[Supabase] Not configured');
        return { rows: [], total: 0 };
    }

    const {
        status = '',
        search = '',
        from = '',
        to = '',
        limit = 50,
        offset = 0,
    } = opts;

    const params = ['select=*', 'order=created_at.desc'];

    if (status) params.push(`status=eq.${encodeURIComponent(status)}`);
    if (search) params.push(`email=ilike.*${encodeURIComponent(search)}*`);
    if (from) params.push(`created_at=gte.${encodeURIComponent(from)}`);
    if (to) params.push(`created_at=lte.${encodeURIComponent(to)}`);

    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 1000);
    const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

    const url = `${SUPABASE_URL}/rest/v1/${TABLE}?${params.join('&')}`;

    try {
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                ...headers(),
                Prefer: 'count=exact',
                Range: `${safeOffset}-${safeOffset + safeLimit - 1}`,
            },
        });

        if (!res.ok) {
            console.warn('[Supabase] list failed:', res.status, await res.text());
            return { rows: [], total: 0 };
        }

        const rows = await res.json();

        // Content-Range looks like "0-49/1234" — the number after / is the total
        let total = rows.length;
        const contentRange = res.headers.get('content-range');
        if (contentRange && contentRange.includes('/')) {
            const parsed = parseInt(contentRange.split('/')[1], 10);
            if (!isNaN(parsed)) total = parsed;
        }

        return { rows, total };
    } catch (err) {
        console.warn('[Supabase] list error:', err.message);
        return { rows: [], total: 0 };
    }
}

module.exports = {
    createAbandonedCheckout,
    attachCheckoutId,
    markCheckoutCompleted,
    listAbandonedCheckouts,
    isConfigured,
};
