/**
 * Check inventory per location for a product variant
 * GET /api/check-inventory?variant_id=XXXXX
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

    try {
        let inventoryItemId;

        if (variant_id) {
            // Get inventory_item_id from variant
            const variantRes = await fetch(
                `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/variants/${variant_id}.json`,
                { headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN } }
            );
            if (!variantRes.ok) throw new Error('Variant not found');
            const variantData = await variantRes.json();
            inventoryItemId = variantData.variant.inventory_item_id;
        } else {
            // Get from product handle
            const prodRes = await fetch(
                `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/products.json?handle=${product_handle}`,
                { headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN } }
            );
            if (!prodRes.ok) throw new Error('Product not found');
            const prodData = await prodRes.json();
            if (!prodData.products.length) throw new Error('Product not found');
            inventoryItemId = prodData.products[0].variants[0].inventory_item_id;
        }

        // Get inventory levels per location
        const invRes = await fetch(
            `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/inventory_levels.json?inventory_item_ids=${inventoryItemId}`,
            { headers: { 'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN } }
        );
        if (!invRes.ok) throw new Error('Inventory fetch failed');
        const invData = await invRes.json();

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
