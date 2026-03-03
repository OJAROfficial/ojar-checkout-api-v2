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

async function shopifyFetch(endpoint) {
    const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/${endpoint}`;
    const response = await fetch(url, {
        headers: {
            'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN,
            'Content-Type': 'application/json'
        }
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Shopify API error (${response.status}): ${text}`);
    }
    return response.json();
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

        // Cache for 60 seconds
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
        return res.status(200).json({ availability });

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};
