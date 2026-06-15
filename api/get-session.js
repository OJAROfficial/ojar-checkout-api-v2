/**
 * Get Stripe Checkout Session Details
 * GET /api/get-session?session_id=xxx
 * 
 * Retrieves session details to display order summary on thank you page
 * Includes gift box properties for items belonging to a gift box bundle
 */

const stripe = require('./utils/stripe');

module.exports = async function handler(req, res) {
    // CORS configuration - allow all OJAR domains
    const origin = req.headers.origin;
    const allowedOrigins = [
        'https://ojarofficial.com',
        'https://www.ojarofficial.com',
        'https://ojarofficial.myshopify.com'
    ];
    const corsOrigin = allowedOrigins.includes(origin) ? origin : 'https://ojarofficial.com';

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', corsOrigin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        return res.status(200).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    try {
        const { session_id } = req.query;

        if (!session_id) {
            return res.status(400).json({ error: 'session_id is required' });
        }

        // Retrieve the session with line items and total details expanded
        const session = await stripe.checkout.sessions.retrieve(session_id, {
            expand: ['line_items', 'line_items.data.price.product', 'total_details.breakdown'],
        });

        // Check if payment was successful (paid OR no_payment_required for 100% off)
        if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
            console.log('[get-session] Payment not completed:', session.payment_status);
            return res.status(400).json({ error: 'Payment not completed' });
        }

        console.log('[get-session] Processing session:', session.id);

        // Parse gift box group data from metadata (if present)
        let giftBoxData = null;
        try {
            if (session.metadata?.gift_box_data) {
                giftBoxData = JSON.parse(session.metadata.gift_box_data);
                console.log('[get-session] Gift box detected:', giftBoxData.name);
            }
        } catch (e) {
            console.warn('[get-session] Failed to parse gift_box_data:', e);
        }

        // Get cart items from metadata (supports both single field and chunks format)
        let items = [];
        try {
            const chunks = parseInt(session.metadata?.cart_items_chunks || '0');
            let cartItems = [];

            if (chunks > 0) {
                // NEW FORMAT: Reassemble from chunks
                console.log('[get-session] Reassembling cart items from', chunks, 'chunks');
                for (let i = 0; i < chunks; i++) {
                    const chunkJson = session.metadata[`cart_items_${i}`];
                    if (chunkJson) {
                        cartItems = cartItems.concat(JSON.parse(chunkJson));
                    }
                }
            } else if (session.metadata?.cart_items_json) {
                // Single field format
                cartItems = JSON.parse(session.metadata.cart_items_json);
            }

            console.log('[get-session] Found cart items in metadata:', cartItems.length);

            if (cartItems.length > 0) {
                // Get Stripe line items for product images
                const stripeLineItems = session.line_items.data.filter(
                    item => item.price.product.name !== 'Shipping'
                );

                // Merge cart data (has variant IDs + properties) with Stripe data (has images)
                items = cartItems.map((cartItem, index) => {
                    const stripeItem = stripeLineItems[index];
                    
                    // Support both new format (v, q, p, t, i) and old format (variantId, quantity, price, name)
                    const variantId = cartItem.v || cartItem.variantId;
                    const quantity = cartItem.q || cartItem.quantity;
                    const price = cartItem.p || cartItem.price;
                    const name = cartItem.t || cartItem.name || cartItem.title || stripeItem?.price.product.name;
                    const itemIndex = cartItem.i;
                    
                    // Build properties object
                    let properties = {};
                    
                    // NEW FORMAT: Use gift_box_data + item index
                    if (giftBoxData && itemIndex) {
                        properties = {
                            _gift_box: 'true',
                            _gift_box_type: giftBoxData.type || '',
                            _gift_box_name: giftBoxData.name || '',
                            _gift_box_group_id: giftBoxData.groupId || '',
                            _gift_box_discount_percent: giftBoxData.discount || '',
                            _gift_box_item_index: itemIndex,
                            _gift_box_total_items: giftBoxData.total || ''
                        };
                    }
                    // OLD FORMAT: properties object with short keys (b, t, n, g, d, i, tt)
                    else if (cartItem.properties && typeof cartItem.properties === 'object') {
                        const p = cartItem.properties;
                        if (p.b) properties._gift_box = p.b;
                        if (p.t) properties._gift_box_type = p.t;
                        if (p.n) properties._gift_box_name = p.n;
                        if (p.g) properties._gift_box_group_id = p.g;
                        if (p.d) properties._gift_box_discount_percent = p.d;
                        if (p.i) properties._gift_box_item_index = p.i;
                        if (p.tt) properties._gift_box_total_items = p.tt;
                    }
                    
                    return {
                        id: variantId,
                        variant_id: variantId,
                        name: name,
                        quantity: quantity,
                        price: price, // Already in cents
                        image: stripeItem?.price.product.images?.[0] || null,
                        properties: properties
                    };
                });
            } else {
                console.log('[get-session] No cart items in metadata, using Stripe line items fallback');
            }
        } catch (e) {
            console.error('Failed to parse cart items from metadata:', e);
            // Fallback to Stripe line items (won't have variant IDs or properties)
            items = session.line_items.data
                .filter(item => item.price.product.name !== 'Shipping')
                .map(item => ({
                    name: item.price.product.name,
                    quantity: item.quantity,
                    price: item.amount_total,
                    image: item.price.product.images?.[0] || null,
                    properties: {}
                }));
        }

        // Get shipping info
        const shippingItem = session.line_items.data.find(
            item => item.price.product.name === 'Shipping'
        );

        // Extract Discount Details
        let discountCode = null;
        let discountAmount = 0;

        if (session.total_details?.breakdown?.discounts?.length > 0) {
            const discountData = session.total_details.breakdown.discounts[0];
            discountAmount = discountData.amount || 0;
            discountCode = discountData.discount?.coupon?.name || discountData.discount?.promotion_code || 'DISCOUNT';
        }

        const responseData = {
            session_id: session.id,
            orderId: session.id,
            customerEmail: session.customer_details?.email,
            customerPhone: session.customer_details?.phone,
            items,
            subtotal: session.amount_subtotal,
            shipping: shippingItem?.amount_total || 0,
            discountTotal: discountAmount,
            discountCode: discountCode,
            total: session.amount_total,
            currency: session.currency.toUpperCase(),
            shippingAddress: session.shipping_details || null,
            // Include gift box info at order level too (for easier frontend detection)
            giftBox: giftBoxData
        };

        console.log('[get-session] Returning data with', items.length, 'items, total:', session.amount_total);

        // Return formatted order summary
        return res.status(200).json(responseData);

    } catch (error) {
        console.error('Get session error:', error);
        return res.status(500).json({
            error: 'Failed to retrieve session',
            message: error.message
        });
    }
};
