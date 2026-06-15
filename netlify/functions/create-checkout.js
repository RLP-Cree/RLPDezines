const { Client, Environment } = require('square');
const crypto = require('crypto');

const client = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: Environment.Production,
});

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

    try {
        const { cartItems } = JSON.parse(event.body);
        if (!cartItems || cartItems.length === 0) return { statusCode: 400, body: JSON.stringify({ error: 'Cart is empty' }) };

        let totalItems = 0;
        const lineItems = cartItems.map(item => {
            totalItems += parseInt(item.quantity);
            return { catalogObjectId: item.id, quantity: String(item.quantity) };
        });

        const baseShippingCents = 900; 
        const extraItemCents = 200;
        const totalShippingCents = baseShippingCents + ((totalItems - 1) * extraItemCents);

        const response = await client.checkoutApi.createPaymentLink({
            idempotencyKey: crypto.randomUUID(),
            order: {
                locationId: process.env.SQUARE_LOCATION_ID,
                lineItems: lineItems
            },
            checkoutOptions: {
                askForShippingAddress: true,
                // THE REDIRECT FIX: Sends them immediately back to your site after payment
                redirectUrl: "https://rlpdezines.com",
                shippingFee: {
                    charge: { amount: totalShippingCents, currency: 'USD' },
                    name: "Standard Shipping"
                },
                acceptedPaymentMethods: { applePay: true, googlePay: true }
            }
        });

        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: response.result.paymentLink.url }) };

    } catch (error) {
        console.error("Checkout Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to create checkout' }) };
    }
};
