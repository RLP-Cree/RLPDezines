const { Client, Environment } = require('square');
const crypto = require('crypto');

const client = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: Environment.Production,
});

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method Not Allowed' })
        };
    }

    try {
        const { cartItems } = JSON.parse(event.body);

        if (!cartItems || cartItems.length === 0) {
            return { statusCode: 400, body: JSON.stringify({ error: 'Cart is empty' }) };
        }

        const lineItems = cartItems.map(item => ({
            name: item.name,
            quantity: String(item.quantity),
            basePriceMoney: {
                amount: Math.round(Number(item.price)),
                currency: 'USD'
            }
        }));

        // CORRECTED: Square expects the order object directly, not wrapped in another 'order' key
        const response = await client.checkoutApi.createPaymentLink({
            idempotencyKey: crypto.randomUUID(),
            order: {
                locationId: process.env.SQUARE_LOCATION_ID,
                lineItems: lineItems
            },
            checkoutOptions: {
                askForShippingAddress: true,
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
        
        // Pinpoint the specific Square API error
        const detail = error.errors?.[0]?.detail || error.message;
        
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Failed to create checkout', details: detail })
        };
    }
};
