/**
 * Stripe Webhook Handler
 * POST /api/webhook
 * 
 * Handles Stripe webhook events, specifically checkout.session.completed
 * to create orders in Shopify after successful payment.
 */

const stripe = require('./utils/stripe');
const { createShopifyOrder } = require('./utils/shopify');
const crypto = require('crypto');

// ===== FACEBOOK CONVERSIONS API =====
/**
 * Send Purchase event to Facebook Conversions API (server-side tracking)
 * More reliable than browser pixels - works even with ad blockers
 */
async function sendFacebookConversionEvent(session, orderData) {
    const FB_PIXEL_ID = process.env.FB_PIXEL_ID;
    const FB_ACCESS_TOKEN = process.env.FB_CONVERSIONS_API_TOKEN;

    if (!FB_PIXEL_ID || !FB_ACCESS_TOKEN) {
        console.log('[FB CAPI] Missing credentials, skipping server-side tracking');
        return;
    }

    try {
        // Hash email for privacy (Facebook requirement)
        const hashedEmail = crypto.createHash('sha256')
            .update(orderData.customer.email.toLowerCase().trim())
            .digest('hex');

        // Hash phone if available
        let hashedPhone = null;
        if (orderData.customer.phone) {
            // Remove non-numeric characters and hash
            const cleanPhone = orderData.customer.phone.replace(/\D/g, '');
            hashedPhone = crypto.createHash('sha256')
                .update(cleanPhone)
                .digest('hex');
        }

        const eventData = {
            data: [{
                event_name: 'Purchase',
                event_time: Math.floor(Date.now() / 1000),
                event_id: session.id, // Deduplication with browser pixel
                action_source: 'website',
                user_data: {
                    em: [hashedEmail],
                    ph: hashedPhone ? [hashedPhone] : undefined,
                    client_ip_address: session.client_ip || undefined,
                    client_user_agent: session.user_agent || undefined,
                },
                custom_data: {
                    currency: orderData.currency,
                    value: orderData.totalAmount / (orderData.currency === 'OMR' || orderData.currency === 'KWD' || orderData.currency === 'BHD' ? 1000 : 100),
                    content_ids: orderData.lineItems.map(i => String(i.variantId)),
                    content_type: 'product',
                    num_items: orderData.lineItems.reduce((sum, i) => sum + i.quantity, 0),
                    order_id: session.id,
                }
            }]
        };

        console.log('[FB CAPI] Sending Purchase event:', JSON.stringify(eventData, null, 2));

        const response = await fetch(
            `https://graph.facebook.com/v18.0/${FB_PIXEL_ID}/events?access_token=${FB_ACCESS_TOKEN}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(eventData)
            }
        );

        const result = await response.json();

        if (result.events_received) {
            console.log('[FB CAPI] ✅ Purchase event sent successfully:', result);
        } else {
            console.error('[FB CAPI] ❌ Failed to send event:', result);
        }
    } catch (error) {
        console.error('[FB CAPI] Error sending conversion event:', error.message);
    }
}

// ===== GOOGLE ADS OFFLINE CONVERSIONS =====
/**
 * Send Purchase conversion to Google Ads (server-side tracking)
 * Uses Google Ads API for offline conversion uploads
 */
async function sendGoogleAdsConversion(session, orderData) {
    const GOOGLE_ADS_CUSTOMER_ID = process.env.GOOGLE_ADS_CUSTOMER_ID; // Format: 123-456-7890
    const GOOGLE_ADS_CONVERSION_ACTION_ID = process.env.GOOGLE_ADS_CONVERSION_ACTION_ID;
    const GOOGLE_ADS_DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    const GOOGLE_ADS_REFRESH_TOKEN = process.env.GOOGLE_ADS_REFRESH_TOKEN;

    // For now, we'll use the simpler Measurement Protocol approach
    // This works with the existing gtag setup
    const GA_MEASUREMENT_ID = process.env.GA_MEASUREMENT_ID || 'G-E1ZPRL98W7';
    const GA_API_SECRET = process.env.GA_API_SECRET;

    if (!GA_API_SECRET) {
        console.log('[Google] Missing GA_API_SECRET, skipping server-side tracking');
        console.log('[Google] To enable: Create API secret in GA4 Admin > Data Streams > Measurement Protocol API secrets');
        return;
    }

    try {
        // Use GA4 Measurement Protocol for server-side events
        const eventData = {
            client_id: session.id, // Use session ID as client ID for server-side
            events: [{
                name: 'purchase',
                params: {
                    transaction_id: session.id,
                    value: orderData.totalAmount / (orderData.currency === 'OMR' || orderData.currency === 'KWD' || orderData.currency === 'BHD' ? 1000 : 100),
                    currency: orderData.currency,
                    items: orderData.lineItems.map(item => ({
                        item_id: String(item.variantId),
                        quantity: item.quantity,
                        price: item.price / (orderData.currency === 'OMR' || orderData.currency === 'KWD' || orderData.currency === 'BHD' ? 1000 : 100),
                    }))
                }
            }]
        };

        console.log('[Google] Sending purchase event via Measurement Protocol:', JSON.stringify(eventData, null, 2));

        const response = await fetch(
            `https://www.google-analytics.com/mp/collect?measurement_id=${GA_MEASUREMENT_ID}&api_secret=${GA_API_SECRET}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(eventData)
            }
        );

        // Measurement Protocol returns 204 No Content on success
        if (response.status === 204 || response.ok) {
            console.log('[Google] ✅ Purchase event sent successfully');
        } else {
            const errorText = await response.text();
            console.error('[Google] ❌ Failed to send event:', response.status, errorText);
        }
    } catch (error) {
        console.error('[Google] Error sending conversion event:', error.message);
    }
}

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

module.exports = async (req, res) => {
    // Add CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, stripe-signature');

    // Handle preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    console.log('=== WEBHOOK RECEIVED ===');
    console.log('Method:', req.method);
    console.log('Headers:', JSON.stringify(req.headers, null, 2));

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
        console.error('Stripe webhook secret not configured');
        return res.status(500).json({ error: 'Webhook not configured' });
    }

    const sig = req.headers['stripe-signature'];

    if (!sig) {
        console.error('No stripe-signature header found');
        return res.status(400).json({ error: 'No signature' });
    }

    let event;
    let rawBody;

    try {
        rawBody = await getRawBody(req);
        console.log('Raw body length:', rawBody.length);
        event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
        console.log('Event type:', event.type);
        console.log('Event ID:', event.id);
    } catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).json({ error: `Webhook Error: ${err.message}` });
    }

    // Handle the event
    try {
        switch (event.type) {
            case 'checkout.session.completed':
                console.log('Processing completed checkout...');
                await handleCheckoutComplete(event.data.object);
                break;

            case 'checkout.session.expired':
                console.log('Processing expired checkout...');
                await handleAbandonedCheckout(event.data.object);
                break;

            case 'payment_intent.payment_failed':
                console.log('Payment failed:', event.data.object.id);
                break;

            default:
                console.log(`Unhandled event type: ${event.type}`);
        }
    } catch (error) {
        console.error('Error processing webhook:', error);
        return res.status(500).json({ error: 'Processing failed' });
    }

    // Return 200 to acknowledge receipt
    console.log('=== WEBHOOK PROCESSED SUCCESSFULLY ===');
    return res.status(200).json({ received: true, eventType: event.type });
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
            expand: ['line_items', 'customer_details', 'payment_intent', 'total_details.breakdown'],
        });
        console.log('Full session retrieved');

        const { customer_details, shipping_details, metadata, payment_intent, total_details } = fullSession;

        console.log('Customer email:', customer_details?.email);
        console.log('Customer phone:', customer_details?.phone);
        console.log('Metadata:', JSON.stringify(metadata));

        // Extract discount code if present
        let discountCode = null;
        let discountAmount = 0;
        if (total_details?.breakdown?.discounts?.length > 0) {
            const discount = total_details.breakdown.discounts[0];
            discountAmount = discount.amount || 0;
            discountCode = discount.discount?.coupon?.name || discount.discount?.promotion_code?.code || 'DISCOUNT';
            console.log('Discount code found:', discountCode, 'Amount:', discountAmount);
        }

        // Parse cart items from metadata
        let cartItems = [];
        try {
            cartItems = JSON.parse(metadata?.cart_items_json || '[]');
            console.log('Parsed cart items:', cartItems.length, 'items');
        } catch (e) {
            console.error('Failed to parse cart items:', e);
            console.log('Raw cart_items_json:', metadata?.cart_items_json);
        }

        if (cartItems.length === 0) {
            console.error('ERROR: No cart items found in metadata!');
            console.log('This might be because cart_items_json was not saved during checkout creation');
            return;
        }

        // Get shipping address - use shipping_details first, then billing (customer_details.address)
        const shippingAddress = shipping_details?.address || customer_details?.address || null;
        // Get billing address separately from customer_details
        const billingAddress = customer_details?.address || shipping_details?.address || null;
        console.log('Shipping address:', JSON.stringify(shippingAddress));
        console.log('Billing address:', JSON.stringify(billingAddress));

        // IMPORTANT: Never silently drop an order! Customer has already paid.
        // If no address found, use placeholder so the order is still created and can be fixed manually.
        const placeholderAddress = {
            line1: 'Address not provided - please contact customer',
            line2: '',
            city: 'Unknown',
            state: '',
            country: metadata?.country_code || 'AE',
            postal_code: '00000',
        };

        const finalShippingAddress = shippingAddress || placeholderAddress;
        const finalBillingAddress = billingAddress || shippingAddress || placeholderAddress;

        if (!shippingAddress) {
            console.warn('WARNING: No shipping address found in session - using placeholder. Order will need manual address update.');
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

        // Create order data
        const orderData = {
            customer: {
                email: customer_details.email,
                name: customer_details.name,
                phone: customer_details.phone,
            },
            lineItems: cartItems,
            shippingAddress: {
                firstName: customer_details.name?.split(' ')[0] || 'Customer',
                lastName: customer_details.name?.split(' ').slice(1).join(' ') || '',
                line1: finalShippingAddress.line1 || '',
                line2: finalShippingAddress.line2 || '',
                city: finalShippingAddress.city || '',
                state: finalShippingAddress.state || '',
                country: finalShippingAddress.country || metadata?.country_code || '',
                postalCode: finalShippingAddress.postal_code || '',
                phone: customer_details.phone || '',
            },
            billingAddress: {
                firstName: customer_details.name?.split(' ')[0] || 'Customer',
                lastName: customer_details.name?.split(' ').slice(1).join(' ') || '',
                line1: finalBillingAddress.line1 || '',
                line2: finalBillingAddress.line2 || '',
                city: finalBillingAddress.city || '',
                state: finalBillingAddress.state || '',
                country: finalBillingAddress.country || metadata?.country_code || '',
                postalCode: finalBillingAddress.postal_code || '',
                phone: customer_details.phone || '',
            },
            addressMissing: !shippingAddress, // Flag for Shopify order tagging
            currency: metadata?.currency || 'USD',
            totalAmount: fullSession.amount_total,
            shippingCost: shippingCost,
            stripePaymentIntentId: payment_intent?.id || session.payment_intent,
            discountCode: discountCode,
            discountAmount: discountAmount,
            // Prioritize marketing consent from cart page, then Stripe's promotional consent
            acceptsMarketing: metadata?.marketing_consent === 'true' || fullSession.consent?.promotional_communications === 'accepted',
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

        // ===== DEDUPLICATION CHECK =====
        // Prevent duplicate orders from Stripe webhook retries
        const stripePaymentId = payment_intent?.id || session.payment_intent;
        if (stripePaymentId) {
            try {
                const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
                const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

                const searchResponse = await fetch(
                    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/orders.json?status=any&tag=stripe:${stripePaymentId}&limit=1`,
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN,
                        },
                    }
                );

                if (searchResponse.ok) {
                    const searchData = await searchResponse.json();
                    if (searchData.orders && searchData.orders.length > 0) {
                        console.log(`=== DUPLICATE DETECTED: Order already exists for payment ${stripePaymentId} ===`);
                        console.log('Existing order ID:', searchData.orders[0].id);
                        console.log('Existing order number:', searchData.orders[0].order_number);
                        console.log('Skipping duplicate order creation.');
                        return; // Exit without creating duplicate
                    }
                }
                console.log('No duplicate found, proceeding with order creation.');
            } catch (dupCheckError) {
                // If dedup check fails, proceed with order creation (better to have a duplicate than no order)
                console.warn('Deduplication check failed, proceeding anyway:', dupCheckError.message);
            }
        }

        // Create order in Shopify
        const shopifyOrder = await createShopifyOrder(orderData);
        console.log('=== SUCCESS: Shopify order created ===');
        console.log('Order ID:', shopifyOrder.order?.id);
        console.log('Order number:', shopifyOrder.order?.order_number);

        // ===== SERVER-SIDE CONVERSION TRACKING =====
        // Fire these asynchronously - don't block the response
        console.log('=== Sending server-side conversion events ===');

        // Facebook Conversions API
        sendFacebookConversionEvent(fullSession, orderData).catch(err => {
            console.error('[FB CAPI] Async error:', err.message);
        });

        // Google Analytics Measurement Protocol
        sendGoogleAdsConversion(fullSession, orderData).catch(err => {
            console.error('[Google] Async error:', err.message);
        });

        console.log('=== Server-side tracking triggered ===');

        // ===== UPDATE CUSTOMER WITH MARKETING CONSENT =====
        // Shopify creates the customer from the order, but we need to explicitly update accepts_marketing
        const marketingConsent = metadata?.marketing_consent === 'true' || fullSession.consent?.promotional_communications === 'accepted';

        if (marketingConsent || metadata?.marketing_consent === 'false') {
            // Only update if we have explicit consent data from cart page
            console.log('Updating customer marketing consent:', marketingConsent);

            // Wait 3 seconds for Shopify to create the customer from the order
            setTimeout(async () => {
                try {
                    // Search for the customer by email
                    const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
                    const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

                    const searchResponse = await fetch(
                        `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/customers/search.json?query=email:${encodeURIComponent(customer_details.email)}`,
                        {
                            headers: {
                                'Content-Type': 'application/json',
                                'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN,
                            },
                        }
                    );

                    const searchData = await searchResponse.json();

                    if (searchData.customers && searchData.customers.length > 0) {
                        const customerId = searchData.customers[0].id;
                        console.log('Found customer after delay, updating marketing consent:', customerId);

                        // Use Shopify's marketing consent API - this is the CORRECT way
                        const consentResponse = await fetch(
                            `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/customers/${customerId}.json`,
                            {
                                method: 'PUT',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN,
                                },
                                body: JSON.stringify({
                                    customer: {
                                        id: customerId,
                                        email_marketing_consent: {
                                            state: marketingConsent ? 'subscribed' : 'not_subscribed',
                                            opt_in_level: marketingConsent ? 'single_opt_in' : 'unknown',
                                            consent_updated_at: new Date().toISOString()
                                        }
                                    }
                                })
                            }
                        );

                        if (consentResponse.ok) {
                            console.log('✅ Customer marketing consent updated successfully via email_marketing_consent API');
                        } else {
                            const errorText = await consentResponse.text();
                            console.error('Failed to update customer consent:', errorText);
                        }
                    } else {
                        console.log('Customer not found even after 3 second delay');
                    }
                } catch (customerError) {
                    console.error('Error updating customer marketing consent:', customerError);
                }
            }, 3000); // 3 second delay
        }

    } catch (error) {
        console.error('=== ERROR: Failed to create Shopify order ===');
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        // Don't throw - we've already received payment, log for manual resolution
    }
}

/**
 * Handle abandoned checkout session - create Shopify draft order for recovery
 */
async function handleAbandonedCheckout(session) {
    console.log('=== WEBHOOK: Processing abandoned checkout ===');
    console.log('Session ID:', session.id);

    try {
        // Get full session details (shipping_details is included by default, don't expand it)
        const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
            expand: ['line_items', 'customer_details'],
        });

        const { customer_details, shipping_details, metadata, total_details, customer } = fullSession;

        // Strategy 0: Check metadata for pre-captured email (from cart page)
        let customerEmail = metadata?.customer_email || null;
        let marketingConsent = metadata?.marketing_consent === 'true';

        if (customerEmail) {
            console.log('Found email in metadata (captured before checkout):', customerEmail);
            console.log('Marketing consent from cart page:', marketingConsent);
        }

        // Strategy 1: Check customer_details (most common for Guest checkout)
        if (!customerEmail) {
            customerEmail = customer_details?.email;
            if (customerEmail) {
                console.log('Found email in customer_details');
            }
        }

        let customerPhone = customer_details?.phone;
        let customerName = customer_details?.name;

        // Strategy 2: Check session.customer_email (pre-filled or captured)
        if (!customerEmail && fullSession.customer_email) {
            console.log('Found email in session.customer_email');
            customerEmail = fullSession.customer_email;
        }

        // Strategy 3: Check Stripe Customer object (if authenticated/Link user)
        if (!customerEmail && customer) {
            console.log('Fetching Stripe Customer object:', customer);
            try {
                const stripeCustomer = await stripe.customers.retrieve(customer);
                if (stripeCustomer && stripeCustomer.email) {
                    console.log('Found email in Stripe Customer object');
                    customerEmail = stripeCustomer.email;
                    if (!customerName) customerName = stripeCustomer.name;
                    if (!customerPhone) customerPhone = stripeCustomer.phone;
                }
            } catch (err) {
                console.error('Failed to retrieve Stripe customer:', err.message);
            }
        }

        if (!customerEmail) {
            console.log('No customer email found in session or customer object - cannot create abandoned cart recovery');
            return;
        }

        // Extract discount code if present
        let discountCode = null;
        let discountAmount = 0;
        if (total_details?.breakdown?.discounts?.length > 0) {
            const discount = total_details.breakdown.discounts[0];
            discountAmount = discount.amount || 0;
            discountCode = discount.discount?.coupon?.name || discount.discount?.promotion_code?.code || 'DISCOUNT';
            console.log('Discount code found:', discountCode, 'Amount:', discountAmount);
        }

        // Parse cart items from metadata
        let cartItems = [];
        try {
            cartItems = JSON.parse(metadata?.cart_items_json || '[]');
        } catch (e) {
            console.error('Failed to parse cart items:', e);
            return;
        }

        if (cartItems.length === 0) {
            console.log('No cart items in abandoned checkout');
            return;
        }

        console.log('Abandoned checkout by:', customerEmail);
        console.log('Customer name:', customer_details?.name);
        console.log('Customer phone:', customer_details?.phone);
        console.log('Items:', cartItems.length);

        // Create a Shopify draft order for abandoned cart recovery
        const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
        const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

        if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_ACCESS_TOKEN) {
            console.error('Shopify credentials not configured');
            return;
        }

        // Get shipping address (prefer shipping_details, fallback to customer billing)
        const shippingAddress = shipping_details?.address || customer_details?.address;

        // Build customer object for draft order
        const customerData = {
            email: customerEmail,
            accepts_marketing: marketingConsent, // Set marketing consent from cart page
        };

        // Add customer name if available
        if (customer_details?.name) {
            const nameParts = customer_details.name.split(' ');
            customerData.first_name = nameParts[0] || '';
            customerData.last_name = nameParts.slice(1).join(' ') || '';
        }

        // Build draft order with full customer details
        const draftOrder = {
            draft_order: {
                email: customerEmail,
                line_items: cartItems.map(item => ({
                    variant_id: item.variantId,
                    quantity: item.quantity,
                })),
                customer: customerData,
                note: `Abandoned Stripe checkout - Session: ${session.id}\nMarketing consent: ${marketingConsent ? 'Yes' : 'No'}`,
                tags: 'abandoned-checkout, stripe-recovery',
            }
        };

        // Add shipping address if available
        if (shippingAddress) {
            draftOrder.draft_order.shipping_address = {
                first_name: customerData.first_name || 'Customer',
                last_name: customerData.last_name || '',
                address1: shippingAddress.line1 || '',
                address2: shippingAddress.line2 || '',
                city: shippingAddress.city || '',
                province: shippingAddress.state || '',
                country: shippingAddress.country || '',
                zip: shippingAddress.postal_code || '',
                phone: customer_details?.phone || '',
            };
            console.log('Shipping address added:', draftOrder.draft_order.shipping_address);
        }

        // Add phone to customer if available
        if (customer_details?.phone) {
            draftOrder.draft_order.phone = customer_details.phone;
            console.log('Customer phone:', customer_details.phone);
        }

        // ===== CREATE/UPDATE SHOPIFY CUSTOMER EXPLICITLY =====
        // Draft orders don't auto-create customers, so we do it manually
        console.log('Creating/updating Shopify customer...');

        try {
            // First, search if customer exists
            const searchResponse = await fetch(
                `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/customers/search.json?query=email:${encodeURIComponent(customerEmail)}`,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN,
                    },
                }
            );

            const searchData = await searchResponse.json();
            let customerId = null;

            if (searchData.customers && searchData.customers.length > 0) {
                // Customer exists - update it
                customerId = searchData.customers[0].id;
                console.log('Customer exists, updating:', customerId);

                const updateResponse = await fetch(
                    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/customers/${customerId}.json`,
                    {
                        method: 'PUT',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN,
                        },
                        body: JSON.stringify({
                            customer: {
                                id: customerId,
                                accepts_marketing: marketingConsent,
                                tags: 'stripe-checkout, abandoned-checkout',
                            }
                        })
                    }
                );

                if (!updateResponse.ok) {
                    console.error('Failed to update customer:', await updateResponse.text());
                }
            } else {
                // Customer doesn't exist - create new
                console.log('Customer does not exist, creating new...');

                const createResponse = await fetch(
                    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/customers.json`,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN,
                        },
                        body: JSON.stringify({
                            customer: {
                                email: customerEmail,
                                first_name: customerData.first_name || 'Customer',
                                last_name: customerData.last_name || '',
                                phone: customer_details?.phone || '',
                                accepts_marketing: marketingConsent,
                                tags: 'stripe-checkout, abandoned-checkout',
                                note: `Abandoned Stripe checkout - Session: ${session.id}`,
                            }
                        })
                    }
                );

                if (createResponse.ok) {
                    const createData = await createResponse.json();
                    customerId = createData.customer.id;
                    console.log('Customer created:', customerId);
                } else {
                    console.error('Failed to create customer:', await createResponse.text());
                }
            }

            console.log('Shopify customer ready:', customerId);
        } catch (customerError) {
            console.error('Error creating/updating customer:', customerError);
            // Continue anyway - draft order will still be created
        }

        // Add discount code to note and apply discount if present
        if (discountCode) {
            draftOrder.draft_order.note = `Abandoned Stripe checkout - Session: ${session.id}\nPromo Code Used: ${discountCode}`;
            console.log('Adding discount to draft order:', discountCode);

            // Apply discount to draft order
            if (discountAmount > 0) {
                draftOrder.draft_order.applied_discount = {
                    description: `${discountCode}`,
                    value_type: 'fixed_amount',
                    value: (discountAmount / 100).toFixed(2),
                    amount: (discountAmount / 100).toFixed(2),
                };
                console.log('Applied discount amount:', (discountAmount / 100).toFixed(2));
            }
        }

        const response = await fetch(
            `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/draft_orders.json`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN,
                },
                body: JSON.stringify(draftOrder),
            }
        );

        if (!response.ok) {
            const error = await response.text();
            console.error('Failed to create draft order:', error);
            return;
        }

        const result = await response.json();
        console.log('=== SUCCESS: Created draft order for abandoned checkout ===');
        console.log('Draft Order ID:', result.draft_order?.id);
        console.log('Customer:', customerEmail);
        console.log('Customer details included:', {
            name: customer_details?.name,
            phone: customer_details?.phone,
            hasShippingAddress: !!shippingAddress
        });

    } catch (error) {
        console.error('=== ERROR: Failed to process abandoned checkout ===');
        console.error('Error:', error.message);
    }
}
