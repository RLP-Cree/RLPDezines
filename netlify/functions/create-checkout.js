const { Client, Environment } = require('square');
const crypto = require('crypto');

const client = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: Environment.Production,
});

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        const { cartItems } = JSON.parse(event.body);

        if (!cartItems || cartItems.length === 0) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Cart is empty' }) };
        }

        let totalItems = 0;

        // ── PRINTFUL & TAX SYNC ──
        // Passing the 'catalogObjectId' (Variation ID) forces Square to pull the exact SKU,
        // Price, and Tax Rules from your Dashboard. This exact ID is what the webhook
        // will pass to Printful so it knows exactly what to print.
        const lineItems = cartItems.map(item => {
            totalItems += parseInt(item.quantity);
            return {
                catalogObjectId: item.id,
                quantity: String(item.quantity)
            };
        });

        // ── SHIPPING CALCULATION ──
        // Square API requires shipping to be explicitly injected for Apple Pay/Google Pay.
        // Base rate: $13.50.00 for the first item. 
        // Additional items: $4.00 per item.
        const baseShippingCents = 1350; 
        const extraItemCents = 400;
        const totalShippingCents = baseShippingCents + ((totalItems - 1) * extraItemCents);

        const response = await client.checkoutApi.createPaymentLink({
            idempotencyKey: crypto.randomUUID(),
            order: {
                locationId: process.env.SQUARE_LOCATION_ID,
                lineItems: lineItems
            },
            checkoutOptions: {
                askForShippingAddress: true,
                // Injects the calculated shipping fee so it appears on the Apple Pay screen
                shippingFee: {
                    charge: {
                        amount: totalShippingCents,
                        currency: 'USD'
                    },
                    name: "Standard Shipping"
                },
                acceptedPaymentMethods: {
                    applePay: true,
                    googlePay: true
                }
            }
        });

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: response.result.paymentLink.url })
        };

    } catch (error) {
        console.error("Checkout Error:", JSON.stringify(error, null, 2));
        const detail = error.errors?.[0]?.detail || error.message;
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to create checkout', details: detail }) };
    }
};
