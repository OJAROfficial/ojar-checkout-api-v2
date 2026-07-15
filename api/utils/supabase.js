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

module.exports = {
    createAbandonedCheckout,
    attachCheckoutId,
    markCheckoutCompleted,
    isConfigured,
};
