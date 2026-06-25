/**
 * Create Stripe Checkout Session
 * POST /api/create-checkout-session
 * 
 * Receives cart data from Shopify theme, creates a Stripe Checkout session
 * with the customer's selected currency and shipping calculated.
 * 
 * Gift box bundles automatically get 30% discount on gift box items only.
 */

const stripe = require('./utils/stripe');

/**
 * Extract gift box group data (shared across all items in a gift box).
 * Returns null if no gift box detected in cart.
 */
function extractGiftBoxData(cartItems) {
    for (const item of cartItems) {
        if (item.properties && item.properties._gift_box === 'true') {
            return {
                type: item.properties._gift_box_type || '',
                name: item.properties._gift_box_name || '',
                groupId: item.properties._gift_box_group_id || '',
                discount: item.properties._gift_box_discount_percent || '',
                total: item.properties._gift_box_total_items || ''
            };
        }
    }
    return null;
}


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

        // Reject only if the entire cart is empty. We KEEP $0 items so freebies/samples
        // appear as line items on the Stripe checkout page (Stripe allows unit_amount: 0
        // when the session total is > 0).
        const paidCartItems = cartItems.filter(item => item.price > 0);
        if (paidCartItems.length === 0) {
            return res.status(400).json({ error: 'No paid items in cart (cannot create $0 checkout)' });
        }

        // Calculate cart total from paid items only (used for shipping threshold)
        const cartTotal = paidCartItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);

        // Check if cart contains only test products (skip shipping for testing)
        const isTestOrder = cartItems.every(item =>
            item.handle?.includes('-copy') || item.handle?.includes('test')
        );

        // Calculate shipping (skip for test orders)
        const shippingCost = isTestOrder ? 0 : calculateShipping(countryCode || 'US', currency, cartTotal);

        // Build Stripe line items — include ALL items (paid + freebies). Freebies render
        // at $0 on the Stripe page so the customer sees what they're getting.
        const lineItems = cartItems.map(item => ({
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
                unit_amount: Math.max(0, Math.round(item.price)),
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

        // Build metadata with smart chunking for large gift box carts
        const sessionMetadata = (function() {
            const meta = {
                shopify_cart_token: cartToken || '',
                currency: currency,
                country_code: countryCode || '',
            };
            
            // Extract gift box group data (shared across all items in a gift box)
            const giftBoxData = extractGiftBoxData(cartItems);
            if (giftBoxData) {
                meta.gift_box_data = JSON.stringify(giftBoxData);
            }
            
            // Build minimal cart items (only per-item data, drop redundant gift box fields)
            const compactItems = cartItems.map(item => {
                const compact = {
                    v: item.variantId,
                    q: item.quantity,
                    p: item.price,
                    t: item.title,
                };
                // Per-item gift box data (only item index)
                if (item.properties && item.properties._gift_box === 'true') {
                    compact.i = item.properties._gift_box_item_index || '';
                }
                return compact;
            });
            
            // Try single field first
            const singleJson = JSON.stringify(compactItems);
            
            if (singleJson.length <= 500) {
                // Fits in single metadata field
                meta.cart_items_json = singleJson;
                meta.cart_items_chunks = '0';
            } else {
                // Split into chunks (max 480 chars per chunk for safety)
                let chunkIndex = 0;
                let currentChunk = [];
                let currentSize = 2; // for [] brackets
                
                for (const item of compactItems) {
                    const itemJson = JSON.stringify(item);
                    // If adding this item exceeds limit, finalize current chunk
                    if (currentSize + itemJson.length + 1 > 480 && currentChunk.length > 0) {
                        meta[`cart_items_${chunkIndex}`] = JSON.stringify(currentChunk);
                        chunkIndex++;
                        currentChunk = [item];
                        currentSize = itemJson.length + 2;
                    } else {
                        currentChunk.push(item);
                        currentSize += itemJson.length + 1; // +1 for comma
                    }
                }
                
                // Save last chunk
                if (currentChunk.length > 0) {
                    meta[`cart_items_${chunkIndex}`] = JSON.stringify(currentChunk);
                    chunkIndex++;
                }
                
                meta.cart_items_chunks = String(chunkIndex);
            }
            
            return meta;
        })();

        // ===== GIFT BOX 30% DISCOUNT LOGIC =====
        // Apply 30% discount ONLY to gift box items (regular products stay full price)
        let sessionDiscounts = null;
        
        const giftBoxItems = cartItems.filter(item => 
            item.properties && item.properties._gift_box === 'true'
        );
        
        if (giftBoxItems.length > 0) {
            try {
                // Calculate gift box subtotal (only gift box items, not regular products)
                const giftBoxSubtotal = giftBoxItems.reduce(
                    (sum, item) => sum + (item.price * item.quantity), 0
                );
                
                // Calculate 30% discount amount
                const discountAmount = Math.round(giftBoxSubtotal * 0.30);
                
                // Get gift box name for coupon label
                const giftBoxName = giftBoxItems[0].properties._gift_box_name || 'Gift Box';
                
                console.log('[CreateSession] Gift box detected:', {
                    items: giftBoxItems.length,
                    subtotal: giftBoxSubtotal,
                    discount: discountAmount,
                    currency: currency,
                    name: giftBoxName
                });
                
                // Create one-time fixed-amount coupon
                // Using fixed amount (not percentage) to ensure discount applies ONLY to gift box items
                const coupon = await stripe.coupons.create({
                    amount_off: discountAmount,
                    currency: currencyLower,
                    duration: 'once',
                    name: `${giftBoxName} - 30% Bundle Discount`,
                    metadata: {
                        gift_box_type: giftBoxItems[0].properties._gift_box_type || '',
                        gift_box_group_id: giftBoxItems[0].properties._gift_box_group_id || '',
                        gift_box_subtotal: String(giftBoxSubtotal),
                        applied_via: 'auto_gift_box_bundle'
                    }
                });
                
                sessionDiscounts = [{ coupon: coupon.id }];
                console.log('[CreateSession] Coupon created:', coupon.id);
                
            } catch (couponError) {
                console.error('[CreateSession] Coupon creation failed:', couponError);
                console.error('Continuing without discount to avoid blocking checkout');
                // Continue without discount - don't block checkout
                sessionDiscounts = null;
            }
        }

        // ===== TRAVEL COLLECTION QUANTITY DISCOUNT =====
        // Items tagged 'Travel' (frontend sends isTravel: true) get a quantity-based discount:
        //   2 travel items = 10%, 3 = 15%, 4+ = 25%. Counts total travel quantity.
        // Valid until 31 July 2026 (end of day UTC). Applies ONLY to travel items' subtotal.
        // Skipped if a gift-box discount is already applied (no stacking).
        // Fully wrapped in try/catch: any failure => checkout continues with NO discount (never blocks).
        if (!sessionDiscounts) {
            try {
                // Offer expiry: 31 July 2026, 23:59:59 UTC (month index 6 = July)
                const TRAVEL_OFFER_END = Date.UTC(2026, 6, 31, 23, 59, 59);
                const nowUtc = Date.now();

                if (nowUtc <= TRAVEL_OFFER_END) {
                    const travelItems = cartItems.filter(it => it.isTravel === true && it.price > 0);
                    const travelQty = travelItems.reduce((sum, it) => sum + (it.quantity || 0), 0);

                    let travelPct = 0;
                    if (travelQty >= 4) travelPct = 0.25;
                    else if (travelQty === 3) travelPct = 0.15;
                    else if (travelQty === 2) travelPct = 0.10;

                    if (travelPct > 0) {
                        const travelSubtotal = travelItems.reduce(
                            (sum, it) => sum + (it.price * it.quantity), 0
                        );
                        const travelDiscountAmount = Math.round(travelSubtotal * travelPct);

                        if (travelDiscountAmount > 0) {
                            const travelCoupon = await stripe.coupons.create({
                                amount_off: travelDiscountAmount,
                                currency: currencyLower,
                                duration: 'once',
                                name: `Travel Offer - ${Math.round(travelPct * 100)}% Off`,
                                metadata: {
                                    applied_via: 'auto_travel_quantity',
                                    travel_qty: String(travelQty),
                                    travel_pct: String(travelPct),
                                    travel_subtotal: String(travelSubtotal),
                                }
                            });

                            sessionDiscounts = [{ coupon: travelCoupon.id }];
                            console.log('[CreateSession] Travel discount applied:', {
                                qty: travelQty,
                                pct: travelPct,
                                subtotal: travelSubtotal,
                                discount: travelDiscountAmount,
                                currency: currency
                            });
                        }
                    }
                }
            } catch (travelErr) {
                console.error('[CreateSession] Travel discount failed (continuing without):', travelErr);
                // Never block checkout — leave sessionDiscounts as-is (null)
                sessionDiscounts = sessionDiscounts || null;
            }
        }

        // Build Stripe Checkout session config
        const sessionConfig = {
            payment_method_types: ['card'],
            line_items: lineItems,
            mode: 'payment',
            success_url: `${process.env.SUCCESS_REDIRECT_URL || 'https://ojarofficial.com/pages/thank-you'}?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.CANCEL_REDIRECT_URL || 'https://ojarofficial.com/cart'}?cancelled=true&restore=${cartToken || ''}`,
            customer_email: customerEmail || undefined,
            phone_number_collection: {
                enabled: true,
            },
            billing_address_collection: 'required',
            shipping_address_collection: {
                // Countries OJAR ships to (per shipping spreadsheet, updated 2026-03-29)
                allowed_countries: [
                    // Europe
                    'AD', 'AL', 'AT', 'BA', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES',
                    'FI', 'FR', 'GB', 'GR', 'HR', 'HU', 'IE', 'IT', 'LI', 'LT', 'MC', 'ME', 'MT',
                    'NL', 'NO', 'PL', 'PT', 'RO', 'RS', 'SE', 'SI', 'SK',
                    // GCC
                    'AE', 'BH', 'KW', 'OM', 'QA', 'SA',
                    // Middle East
                    'LB',
                    // USA
                    'US',
                ],
            },
            metadata: sessionMetadata,
        };

        // Apply discounts vs allow_promotion_codes (Stripe restriction: mutually exclusive)
        if (sessionDiscounts) {
            sessionConfig.discounts = sessionDiscounts;
            // Note: When auto-discount applied, customer cannot enter manual promo codes
        } else {
            sessionConfig.allow_promotion_codes = true;
        }

        // Create Stripe Checkout session
        const session = await stripe.checkout.sessions.create(sessionConfig);

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
