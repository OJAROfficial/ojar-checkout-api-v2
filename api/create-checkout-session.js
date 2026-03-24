/**
 * Create Stripe Checkout Session
 * POST /api/create-checkout-session
 * 
 * Receives cart data from Shopify theme, creates a Stripe Checkout session
 * with the customer's selected currency and shipping calculated.
 */

const stripe = require('./utils/stripe');
const { calculateShipping } = require('./utils/shipping');

// Currency configuration
const CURRENCY_CONFIG = {
    'USD': { symbol: '$', multiplier: 100 },
    'EUR': { symbol: '€', multiplier: 100 },
    'GBP': { symbol: '£', multiplier: 100 },
    'SAR': { symbol: 'SAR', multiplier: 100 },
    'AED': { symbol: 'AED', multiplier: 100 },
    'QAR': { symbol: 'QAR', multiplier: 100 },
    'OMR': { symbol: 'OMR', multiplier: 1000 }, // OMR uses 3 decimal places
    'KWD': { symbol: 'KWD', multiplier: 1000 }, // KWD uses 3 decimal places
    'BHD': { symbol: 'BHD', multiplier: 1000 }, // BHD uses 3 decimal places
};

module.exports = async function handler(req, res) {
    // Get origin from request
    const origin = req.headers.origin;
    const allowedOrigins = ['https://ojarofficial.com', 'https://www.ojarofficial.com', 'https://ojarofficial.myshopify.com'];

    // Set CORS headers for allowed origins
    if (allowedOrigins.includes(origin) || !origin) {
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
    } else {
        res.setHeader('Access-Control-Allow-Origin', 'https://ojarofficial.com');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const {
            cartItems,        // Array of { handle, variantId, title, quantity, price, image }
            currency,         // Selected currency code (USD, EUR, GBP, etc.)
            countryCode,      // Customer's country code for shipping
            customerEmail,    // Optional: pre-fill email
            cartToken,        // Shopify cart token for restoration
        } = req.body;

        // Validate required fields
        if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
            return res.status(400).json({ error: 'Cart items are required' });
        }

        if (!currency || !CURRENCY_CONFIG[currency]) {
            return res.status(400).json({ error: 'Invalid currency' });
        }

        const currencyLower = currency.toLowerCase();
        const currencyMultiplier = CURRENCY_CONFIG[currency].multiplier;

        // Filter out zero-price items (bundle/gift set components sent at $0)
        const validCartItems = cartItems.filter(item => item.price > 0);

        if (validCartItems.length === 0) {
            return res.status(400).json({ error: 'No valid items in cart (all items are $0)' });
        }

        // Calculate cart total (prices already in smallest unit from frontend)
        const cartTotal = validCartItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);

        // Check if cart contains only test products (skip shipping for testing)
        const isTestOrder = cartItems.every(item =>
            item.handle?.includes('-copy') || item.handle?.includes('test')
        );

        // Calculate shipping (skip for test orders)
        const shippingCost = isTestOrder ? 0 : calculateShipping(countryCode || 'US', currency, cartTotal);

        // Build Stripe line items (only valid non-$0 items)
        const lineItems = validCartItems.map(item => ({
            price_data: {
                currency: currencyLower,
                product_data: {
                    name: item.title,
                    images: item.image ? [item.image] : [],
                    metadata: {
                        shopify_handle: item.handle,
                        shopify_variant_id: item.variantId,
                    },
                },
                unit_amount: item.price, // Already in smallest unit
            },
            quantity: item.quantity,
        }));

        // Add shipping as a line item if there's a cost
        if (shippingCost > 0) {
            lineItems.push({
                price_data: {
                    currency: currencyLower,
                    product_data: {
                        name: 'Shipping',
                        description: 'International shipping',
                    },
                    unit_amount: shippingCost,
                },
                quantity: 1,
            });
        }

        // Create Stripe Checkout session
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: lineItems,
            mode: 'payment',
            success_url: `${process.env.SUCCESS_REDIRECT_URL || 'https://ojarofficial.com/pages/thank-you'}?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.CANCEL_REDIRECT_URL || 'https://ojarofficial.com/cart'}?cancelled=true&restore=${cartToken || ''}`,
            customer_email: customerEmail || undefined,
            billing_address_collection: 'required',
            shipping_address_collection: {
                allowed_countries: [
                    'AE', 'SA', 'KW', 'BH', 'OM', 'QA', // GCC
                    'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'AT', 'CH', // Europe
                    'US', 'CA', // North America
                    'AU', 'NZ', // Oceania
                    'JP', 'SG', 'HK', 'MY', 'IN', // Asia
                ],
            },
            metadata: {
                shopify_cart_token: cartToken || '',
                currency: currency,
                country_code: countryCode || '',
                cart_items_json: JSON.stringify(validCartItems.map(item => ({
                    variantId: item.variantId,
                    quantity: item.quantity,
                    price: item.price,
                }))),
            },
            // Allow customer to adjust quantity at checkout
            allow_promotion_codes: true,
        });

        // Return the checkout session URL
        return res.status(200).json({
            sessionId: session.id,
            checkoutUrl: session.url,
        });

    } catch (error) {
        console.error('Stripe Checkout error:', error);
        return res.status(500).json({
            error: 'Failed to create checkout session',
            message: error.message
        });
    }
};
