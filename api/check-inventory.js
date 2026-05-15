/**
 * Check inventory per location for a product variant
 * GET /api/check-inventory?variant_id=XXXXX
 * GET /api/check-inventory?product_handle=XXXXX
 * 
 * Returns per-location availability so the theme can show
 * "Sold Out" based on the customer's market warehouse.
 */

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

// Location ID to name mapping
const LOCATIONS = {
    '68135977075': 'ALFUTTAIM LOGISTICS',
    '69179867251': 'Carrylog Warehouse',
    '77866500211': 'Saudia warehouse'
};

// In-memory cache (per Vercel instance)
// Reduces repeated Shopify calls for the same product within the TTL window
const cache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

function getCached(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
        cache.delete(key);
        return null;
    }
    return entry.data;
}

function setCached(key, data) {
    cache.set(key, { data, timestamp: Date.now() });
    // Prevent unbounded memory growth
    if (cache.size > 500) {
        const firstKey = cache.keys().next().value;
        cache.delete(firstKey);
    }
}

/**
 * Sleep helper for backoff
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch from Shopify with automatic retry on rate limit (429)
 * Uses exponential backoff respecting the Retry-After header
 */
async function shopifyFetch(endpoint, maxRetries = 2) {
    const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/${endpoint}`;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const response = await fetch(url, {
            headers: {
                'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN,
                'Content-Type': 'application/json'
            }
        });

        // Handle rate limit
        if (response.status === 429) {
            if (attempt === maxRetries) {
                const err = new Error('Shopify rate limit exceeded after retries');
                err.code = 'RATE_LIMITED';
                throw err;
            }
            // Respect Retry-After header if present, else exponential backoff
            const retryAfter = parseFloat(response.headers.get('Retry-After')) || (Math.pow(2, attempt) * 0.5);
            const waitMs = Math.min(retryAfter * 1000, 3000); // cap at 3 sec
            console.warn(`[shopifyFetch] 429 received for ${endpoint}, retrying after ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`);
            await sleep(waitMs);
            continue;
        }

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Shopify API error (${response.status}): ${text}`);
        }
        return response.json();
    }
}

module.exports = async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { variant_id, product_handle } = req.query;

    if (!variant_id && !product_handle) {
        return res.status(400).json({ error: 'variant_id or product_handle required' });
    }

    // Debug: check if env vars exist
    if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_ACCESS_TOKEN) {
        return res.status(500).json({ 
            error: 'Missing env vars',
            hasDomain: !!SHOPIFY_STORE_DOMAIN,
            hasToken: !!SHOPIFY_ADMIN_ACCESS_TOKEN
        });
    }

    // Check in-memory cache first
    const cacheKey = variant_id ? `v:${variant_id}` : `p:${product_handle}`;
    const cached = getCached(cacheKey);
    if (cached) {
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
        res.setHeader('X-Cache', 'HIT');
        return res.status(200).json(cached);
    }

    try {
        let inventoryItemId;

        if (variant_id) {
            const variantData = await shopifyFetch(`variants/${variant_id}.json`);
            inventoryItemId = variantData.variant.inventory_item_id;
        } else {
            const prodData = await shopifyFetch(`products.json?handle=${product_handle}`);
            if (!prodData.products || !prodData.products.length) {
                return res.status(404).json({ error: 'Product not found', handle: product_handle, domain: SHOPIFY_STORE_DOMAIN });
            }
            inventoryItemId = prodData.products[0].variants[0].inventory_item_id;
        }

        // Get inventory levels per location
        const invData = await shopifyFetch(`inventory_levels.json?inventory_item_ids=${inventoryItemId}`);

        const availability = {};
        for (const level of invData.inventory_levels) {
            const locName = LOCATIONS[String(level.location_id)] || String(level.location_id);
            availability[locName] = level.available > 0;
        }

        const response = { availability };

        // Store in cache
        setCached(cacheKey, response);

        // CDN cache headers
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
        res.setHeader('X-Cache', 'MISS');
        return res.status(200).json(response);

    } catch (error) {
        // Handle rate limit gracefully — don't return 500
        if (error.code === 'RATE_LIMITED') {
            console.error('[check-inventory] Rate limited by Shopify after retries');
            res.setHeader('Retry-After', '5');
            return res.status(503).json({ 
                error: 'Service temporarily unavailable, please retry',
                retryAfter: 5
            });
        }
        
        console.error('[check-inventory] Error:', error.message);
        return res.status(500).json({ error: error.message });
    }
};
