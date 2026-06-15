/**
 * Get Stripe Checkout Session Details
 * GET /api/get-session?session_id=xxx
 * 
 * Retrieves session details to display order summary on thank you page
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

        // Check if payment was successful
        // Check if payment was successful (paid OR no_payment_required for 100% off)
        if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
            console.log('[get-session] Payment not completed:', session.payment_status);
            return res.status(400).json({ error: 'Payment not completed' });
        }

        console.log('[get-session] Processing session:', session.id);

        // Get cart items from metadata (has variant IDs needed for tracking)
        let items = [];
        try {
            const cartItemsJson = session.metadata?.cart_items_json;
            if (cartItemsJson) {
                const cartItems = JSON.parse(cartItemsJson);
                console.log('[get-session] Found cart items in metadata:', cartItems.length);

                // Get Stripe line items for product images
                const stripeLineItems = session.line_items.data.filter(
                    item => item.price.product.name !== 'Shipping'
                );

                // Merge cart data (has variant IDs) with Stripe data (has images)
                items = cartItems.map((cartItem, index) => {
                    const stripeItem = stripeLineItems[index];
                    return {
                        id: cartItem.variantId,
                        variant_id: cartItem.variantId,
                        name: cartItem.name || stripeItem?.price.product.name,
                        quantity: cartItem.quantity,
                        price: cartItem.price, // Already in cents
                        image: stripeItem?.price.product.images?.[0] || null,
                    };
                });
            } else {
                console.log('[get-session] No cart_items_json in metadata');
            }
        } catch (e) {
            console.error('Failed to parse cart items from metadata:', e);
            // Fallback to Stripe line items (won't have variant IDs)
            items = session.line_items.data
                .filter(item => item.price.product.name !== 'Shipping')
                .map(item => ({
                    name: item.price.product.name,
                    quantity: item.quantity,
                    price: item.amount_total,
                    image: item.price.product.images?.[0] || null,
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
