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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Method Not Allowed' })
        };
    }

    try {
        let body;
        try {
            body = JSON.parse(event.body);
        } catch (e) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Invalid JSON body' })
            };
        }

        const { cartItems } = body;
        if (!Array.isArray(cartItems) || cartItems.length === 0) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'cartItems is required' })
            };
        }

        const lineItems = cartItems.map(item => ({
            name: item.name,
            quantity: String(item.quantity),
            basePriceMoney: {
                amount: Math.round(Number(item.price)), // already cents
                currency: 'USD'
            }
        }));

        const response = await client.checkoutApi.createPaymentLink({
            idempotencyKey: crypto.randomUUID(),
            order: {
                order: {
                    locationId: process.env.SQUARE_LOCATION_ID,
                    lineItems
                }
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
            body: JSON.stringify({
                url: response.result.paymentLink.url
            })
        };

    } catch (error) {
        console.error("Checkout Error:", error);

        const detail =
            error?.errors?.[0]?.detail ||
            error?.errors?.[0]?.code ||
            error.message;

        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                error: 'Failed to create checkout',
                details: detail
            })
        };
    }
};
