// netlify/functions/create-checkout.js
const { Client, Environment } = require('square');
const crypto = require('crypto');

const client = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: process.env.SQUARE_ENVIRONMENT === 'production' ? Environment.Production : Environment.Sandbox,
});

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        const { cartItems, customerEmail } = JSON.parse(event.body);

        const lineItems = cartItems.map(item => ({
            name: item.name,
            quantity: item.quantity.toString(),
            basePriceMoney: {
                amount: item.price, // Price in cents
                currency: 'USD'
            }
        }));

        const response = await client.checkoutApi.createPaymentLink(process.env.SQUARE_LOCATION_ID, {
            idempotencyKey: crypto.randomUUID(),
            quickPay: {
                name: "RLP Dezines Order",
                priceMoney: {
                    amount: cartItems.reduce((total, item) => total + (item.price * item.quantity), 0),
                    currency: 'USD'
                },
                locationId: process.env.SQUARE_LOCATION_ID
            },
            order: {
                locationId: process.env.SQUARE_LOCATION_ID,
                lineItems: lineItems
            },
            checkoutOptions: {
                askForShippingAddress: true,
                acceptedPaymentMethods: { applePay: true, googlePay: true }
            }
        });

        return {
            statusCode: 200,
            body: JSON.stringify({ url: response.result.paymentLink.url })
        };
    } catch (error) {
        console.error("Checkout Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to create checkout' }) };
    }
};
