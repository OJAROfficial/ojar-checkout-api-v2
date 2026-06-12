/**
 * Stripe Webhook Handler
 * POST /api/webhook
 * 
 * Handles Stripe webhook events, specifically checkout.session.completed
 * to create orders in Shopify after successful payment.
 */

const stripe = require('./utils/stripe');
const { createShopifyOrder } = require('./utils/shopify');

// Disable body parsing - Stripe requires raw body for signature verification
module.exports.config = {
    api: {
        bodyParser: false,
    },
};

// Helper to get raw body
async function getRawBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
        console.error('Stripe webhook secret not configured');
        return res.status(500).json({ error: 'Webhook not configured' });
    }

    const sig = req.headers['stripe-signature'];
    let event;
    let rawBody;

    try {
        rawBody = await getRawBody(req);
        event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).json({ error: `Webhook Error: ${err.message}` });
    }

    // Handle the event
    switch (event.type) {
        case 'checkout.session.completed':
            await handleCheckoutComplete(event.data.object);
            break;

        case 'payment_intent.payment_failed':
            console.log('Payment failed:', event.data.object.id);
            break;

        default:
            console.log(`Unhandled event type: ${event.type}`);
    }

    // Return 200 to acknowledge receipt
    return res.status(200).json({ received: true });
};

/**
 * Handle completed checkout session - create Shopify order
 */
async function handleCheckoutComplete(session) {
    console.log('=== WEBHOOK: Processing checkout ===');
    console.log('Session ID:', session.id);

    try {
        // Get full session with line items
        console.log('Fetching full session from Stripe...');
        const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
            expand: ['line_items', 'line_items.data.price.product', 'customer_details', 'payment_intent', 'total_details.breakdown'],
        });
        console.log('Full session retrieved');

        const { customer_details, shipping_details, metadata, payment_intent } = fullSession;

        console.log('Customer email:', customer_details?.email);
        console.log('Metadata:', JSON.stringify(metadata));

            // Parse cart items from metadata (supports both new chunks format and old format)
            let cartItems = [];
            let giftBoxData = null;
            
            try {
                // Parse gift box group data (NEW format)
                if (metadata?.gift_box_data) {
                    giftBoxData = JSON.parse(metadata.gift_box_data);
                    console.log('Gift box data:', giftBoxData);
                }
                
                // Determine if cart items are split into chunks
                const chunks = parseInt(metadata?.cart_items_chunks || '0');
                let rawItems = [];
                
                if (chunks > 0) {
                    // Reassemble from chunks (NEW format for large carts)
                    console.log('Reassembling cart items from', chunks, 'chunks');
                    for (let i = 0; i < chunks; i++) {
                        const chunkJson = metadata[`cart_items_${i}`];
                        if (chunkJson) {
                            rawItems = rawItems.concat(JSON.parse(chunkJson));
                        }
                    }
                } else {
                    // Single field (NEW format under 500 chars OR OLD format)
                    rawItems = JSON.parse(metadata?.cart_items_json || '[]');
                }
                
                // Process each item with backward compatibility
                cartItems = rawItems.map(item => {
                    const expanded = {
                        variantId: item.v || item.variantId,
                        quantity: item.q || item.quantity,
                        price: item.p || item.price,
                        title: item.t || item.title,
                        properties: {}
                    };
                    
                    // NEW FORMAT: gift_box_data + item index (i)
                    if (giftBoxData && item.i) {
                        expanded.properties = {
                            _gift_box: 'true',
                            _gift_box_type: giftBoxData.type,
                            _gift_box_name: giftBoxData.name,
                            _gift_box_group_id: giftBoxData.groupId,
                            _gift_box_discount_percent: giftBoxData.discount,
                            _gift_box_item_index: item.i,
                            _gift_box_total_items: giftBoxData.total
                        };
                    }
                    // OLD FORMAT: properties object with short keys (b, t, n, g, d, i, tt)
                    else if (item.properties && typeof item.properties === 'object' && Object.keys(item.properties).length > 0) {
                        if (item.properties.b) expanded.properties._gift_box = item.properties.b;
                        if (item.properties.t) expanded.properties._gift_box_type = item.properties.t;
                        if (item.properties.n) expanded.properties._gift_box_name = item.properties.n;
                        if (item.properties.g) expanded.properties._gift_box_group_id = item.properties.g;
                        if (item.properties.d) expanded.properties._gift_box_discount_percent = item.properties.d;
                        if (item.properties.i) expanded.properties._gift_box_item_index = item.properties.i;
                        if (item.properties.tt) expanded.properties._gift_box_total_items = item.properties.tt;
                    }
                    
                    return expanded;
                });
                
                console.log('Parsed cart items:', cartItems.length, 'items');
            } catch (e) {
                console.error('Failed to parse cart items:', e);
                console.log('Raw metadata:', JSON.stringify(metadata));
            }

        // Keep $0 freebies/samples so the Shopify order shows what the customer received.
        // Only abort if there are no items at all.
        if (cartItems.length === 0) {
            console.log('SKIPPING: No cart items in metadata, not creating Shopify order');
            return;
        }

        // Skip entirely if the session total amount is $0
        if (fullSession.amount_total === 0) {
            console.log('SKIPPING: $0 total order, not creating Shopify order');
            return;
        }

        // Get shipping address
        const shippingAddress = shipping_details?.address || customer_details?.address;
        console.log('Shipping address:', JSON.stringify(shippingAddress));

        if (!shippingAddress) {
            console.error('ERROR: No shipping address found in session');
            return;
        }

        // Calculate shipping cost from line items
        let shippingCost = 0;
        const lineItems = fullSession.line_items?.data || [];
        console.log('Line items from Stripe:', lineItems.length);

        const shippingItem = lineItems.find(item =>
            item.description === 'Shipping' || item.price?.product?.name === 'Shipping'
        );
        if (shippingItem) {
            shippingCost = shippingItem.amount_total;
            console.log('Shipping cost:', shippingCost);
        }

        // Extract discount from Stripe session (coupon codes)
        let discountCode = null;
        let discountAmount = 0;
        if (fullSession.total_details?.breakdown?.discounts?.length > 0) {
            const d = fullSession.total_details.breakdown.discounts[0];
            discountAmount = d.amount || 0;
            discountCode = d.discount?.coupon?.name || d.discount?.coupon?.id || null;
            console.log('Discount code:', discountCode, 'Amount:', discountAmount);
        }

        // Create order data
        const orderData = {
            customer: {
                email: customer_details.email,
                name: customer_details.name,
            },
            lineItems: cartItems,
            shippingAddress: {
                firstName: customer_details.name?.split(' ')[0] || 'Customer',
                lastName: customer_details.name?.split(' ').slice(1).join(' ') || '',
                line1: shippingAddress.line1,
                line2: shippingAddress.line2,
                city: shippingAddress.city,
                state: shippingAddress.state,
                country: shippingAddress.country,
                postalCode: shippingAddress.postal_code,
                phone: customer_details.phone,
            },
            currency: metadata?.currency || 'USD',
            totalAmount: fullSession.amount_total,
            shippingCost: shippingCost,
            stripePaymentIntentId: payment_intent?.id || session.payment_intent,
            discountCode,
            discountAmount,
        };

        console.log('Order data prepared:', JSON.stringify(orderData, null, 2));

        // Check Shopify credentials
        if (!process.env.SHOPIFY_STORE_DOMAIN) {
            console.error('ERROR: SHOPIFY_STORE_DOMAIN not set!');
            return;
        }
        if (!process.env.SHOPIFY_ADMIN_ACCESS_TOKEN) {
            console.error('ERROR: SHOPIFY_ADMIN_ACCESS_TOKEN not set!');
            return;
        }
        console.log('Shopify credentials present, creating order...');

        // Create order in Shopify
        const shopifyOrder = await createShopifyOrder(orderData);
        console.log('=== SUCCESS: Shopify order created ===');
        console.log('Order ID:', shopifyOrder.order?.id);
        console.log('Order number:', shopifyOrder.order?.order_number);

    } catch (error) {
        console.error('=== ERROR: Failed to create Shopify order ===');
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        // Don't throw - we've already received payment, log for manual resolution
    }
}
