/**
 * Shopify Admin API client for creating orders
 */

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

// 3-decimal currencies: Stripe stores amounts with multiplier 1000 (not 100)
const THREE_DECIMAL_CURRENCIES = ['BHD', 'KWD', 'OMR'];

/**
 * Get the correct divisor for converting Stripe smallest-unit amounts to decimal.
 * BHD, KWD, OMR use 3 decimal places (divisor 1000), all others use 2 (divisor 100).
 */
function getCurrencyDivisor(currency) {
    return THREE_DECIMAL_CURRENCIES.includes(currency?.toUpperCase()) ? 1000 : 100;
}

/**
 * Get the correct number of decimal places for a currency.
 */
function getCurrencyDecimals(currency) {
    return THREE_DECIMAL_CURRENCIES.includes(currency?.toUpperCase()) ? 3 : 2;
}

/**
 * Map UAE emirate names from Stripe to Shopify province codes.
 * Stripe returns full emirate names; Shopify expects province codes.
 */
const UAE_PROVINCE_MAP = {
    'abu dhabi': 'AZ',
    'abu zaby': 'AZ',
    'ajman': 'AJ',
    'fujairah': 'FU',
    'al fujairah': 'FU',
    'ras al-khaimah': 'RK',
    'ras al khaimah': 'RK',
    'sharjah': 'SH',
    'al sharjah': 'SH',
    'dubai': 'DU',
    'umm al-quwain': 'UQ',
    'umm al quwain': 'UQ',
};

/**
 * Normalize province/state for Shopify. For UAE, map emirate names to codes.
 */
function normalizeProvince(country, state, city) {
    if (country === 'AE') {
        // Try state first, then city (Stripe sometimes puts emirate in city)
        const candidates = [state, city].filter(Boolean);
        for (const candidate of candidates) {
            const mapped = UAE_PROVINCE_MAP[candidate.toLowerCase().trim()];
            if (mapped) return mapped;
        }
        // If we still have a state value, return it as-is
        return state || city || '';
    }
    return state || '';
}

/**
 * Create an order in Shopify after successful Stripe payment
 * @param {Object} orderData - Order details from Stripe checkout
 * @returns {Object} Created Shopify order
 */
async function createShopifyOrder(orderData) {
    const {
        customer,
        lineItems,
        shippingAddress,
        currency,
        totalAmount,
        stripePaymentIntentId,
        shippingCost,
        discountCode,
        discountAmount,
    } = orderData;

    // Guard: never create $0 orders
    if (!totalAmount || totalAmount <= 0) {
        console.log('SKIPPING: Refusing to create $0 Shopify order (totalAmount:', totalAmount, ')');
        return { order: null, skipped: true };
    }

    // Filter out any $0 line items (bundle/gift set components)
    const validLineItems = lineItems.filter(item => item.price > 0);
    if (validLineItems.length === 0) {
        console.log('SKIPPING: All line items are $0, refusing to create Shopify order');
        return { order: null, skipped: true };
    }

    // Use correct divisor based on currency (1000 for BHD/KWD/OMR, 100 for all others)
    const divisor = getCurrencyDivisor(currency);
    const decimals = getCurrencyDecimals(currency);
    console.log(`Currency: ${currency}, divisor: ${divisor}, decimals: ${decimals}`);

    // Normalize province for UAE addresses
    const province = normalizeProvince(
        shippingAddress.country,
        shippingAddress.state,
        shippingAddress.city
    );

    const shopifyOrder = {
        order: {
            email: customer.email,
            financial_status: 'paid',
            send_receipt: true,
            send_fulfillment_receipt: true,
            note: `Stripe Payment ID: ${stripePaymentIntentId}`,
            tags: 'stripe-checkout, multi-currency',
            currency: currency,
            line_items: validLineItems.map(item => ({
                variant_id: item.variantId,
                quantity: item.quantity,
                price: (item.price / divisor).toFixed(decimals),
            })),
            shipping_address: {
                first_name: shippingAddress.firstName,
                last_name: shippingAddress.lastName,
                address1: shippingAddress.line1 || '',
                address2: shippingAddress.line2 || '',
                city: shippingAddress.city || '',
                province: province,
                country_code: shippingAddress.country,
                zip: shippingAddress.postalCode || '',
                phone: shippingAddress.phone || '',
            },
            billing_address: {
                first_name: shippingAddress.firstName,
                last_name: shippingAddress.lastName,
                address1: shippingAddress.line1 || '',
                address2: shippingAddress.line2 || '',
                city: shippingAddress.city || '',
                province: province,
                country_code: shippingAddress.country,
                zip: shippingAddress.postalCode || '',
                phone: shippingAddress.phone || '',
            },
            shipping_lines: [
                {
                    title: 'International Shipping',
                    price: (shippingCost / divisor).toFixed(decimals),
                    code: 'INTL',
                }
            ],
            transactions: [
                {
                    kind: 'sale',
                    status: 'success',
                    amount: (totalAmount / divisor).toFixed(decimals),
                    gateway: 'Stripe',
                }
            ],
            // Forward Stripe coupon/discount to Shopify so admin panel shows correct breakdown
            discount_codes: discountCode ? [
                {
                    code: discountCode,
                    amount: (discountAmount / divisor).toFixed(decimals),
                    type: 'fixed_amount',
                }
            ] : [],
        }
    };

    const response = await fetch(
        `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/orders.json`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN,
            },
            body: JSON.stringify(shopifyOrder),
        }
    );

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Shopify order creation failed: ${error}`);
    }

    return response.json();
}

/**
 * Get variant ID by product handle and SKU
 * @param {string} handle - Product handle
 * @returns {Object} Product data with variants
 */
async function getProductByHandle(handle) {
    const response = await fetch(
        `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/products.json?handle=${handle}`,
        {
            headers: {
                'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN,
            },
        }
    );

    if (!response.ok) {
        throw new Error(`Failed to fetch product: ${handle}`);
    }

    const data = await response.json();
    return data.products[0];
}

module.exports = {
    createShopifyOrder,
    getProductByHandle,
};
