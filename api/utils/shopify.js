/**
 * Shopify Admin API client for creating orders
 */

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

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
        billingAddress,
        addressMissing,
        currency,
        totalAmount,
        shippingCost,
        stripePaymentIntentId,
        discountCode,
        discountAmount,
        acceptsMarketing
    } = orderData;

    // Use billing address if provided, otherwise fall back to shipping address
    const finalBillingAddress = billingAddress || shippingAddress;

    // Check if currency uses 3 decimals (KWD, OMR, BHD)
    const is3DecimalCurrency = ['KWD', 'OMR', 'BHD'].includes(currency?.toUpperCase());
    const divisor = is3DecimalCurrency ? 1000 : 100;

    const shopifyOrder = {
        order: {
            email: customer.email,
            // NOTE: Removed phone - Shopify validation too strict, phone still in addresses
            customer: {
                first_name: shippingAddress.firstName,
                last_name: shippingAddress.lastName,
                email: customer.email,
                accepts_marketing: acceptsMarketing || false,
            },
            financial_status: 'paid',
            send_receipt: true,
            send_fulfillment_receipt: true,
            note: discountCode ? `Promo Code: ${discountCode}` : '',
            note_attributes: [
                { name: 'stripe_payment_id', value: stripePaymentIntentId },
                ...(discountCode ? [
                    { name: 'discount_code', value: discountCode },
                    { name: 'discount_amount', value: `${(discountAmount / divisor).toFixed(2)} ${currency}` }
                ] : [])
            ],
            tags: `stripe-checkout, multi-currency, stripe:${stripePaymentIntentId}${discountCode ? `, promo:${discountCode}` : ''}${addressMissing ? ', needs-address-review' : ''}`,
            discount_codes: discountCode ? [
                {
                    code: discountCode,
                    amount: (discountAmount / divisor).toFixed(2),
                    type: 'fixed_amount'
                }
            ] : undefined,
            currency: currency,
            line_items: lineItems.map(item => ({
                variant_id: item.variantId,
                quantity: item.quantity,
                price: (item.price / divisor).toFixed(2), // Divide by 1000 for KWD/OMR/BHD
            })),
            shipping_address: {
                first_name: shippingAddress.firstName || 'Customer',
                last_name: shippingAddress.lastName || '',
                address1: shippingAddress.line1 || 'Address not provided',
                address2: shippingAddress.line2 || '',
                city: shippingAddress.city || 'Unknown',
                province: shippingAddress.state || '',
                country: shippingAddress.country || '',
                zip: shippingAddress.postalCode || '',
                phone: shippingAddress.phone || '',
            },
            billing_address: {
                first_name: finalBillingAddress.firstName || 'Customer',
                last_name: finalBillingAddress.lastName || '',
                address1: finalBillingAddress.line1 || 'Address not provided',
                address2: finalBillingAddress.line2 || '',
                city: finalBillingAddress.city || 'Unknown',
                province: finalBillingAddress.state || '',
                country: finalBillingAddress.country || '',
                zip: finalBillingAddress.postalCode || '',
                phone: finalBillingAddress.phone || '',
            },
            shipping_lines: [
                {
                    title: 'International Shipping',
                    price: (shippingCost / divisor).toFixed(2),
                    code: 'INTL',
                }
            ],
            transactions: [
                {
                    kind: 'sale',
                    status: 'success',
                    amount: Math.max((totalAmount / divisor), 0.01).toFixed(2),
                    gateway: 'Stripe',
                }
            ]
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
