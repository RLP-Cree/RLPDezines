const { Client, Environment } = require('square');
const crypto = require('crypto');

const squareClient = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: Environment.Production,
});

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };

    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

    let body;
    try {
        body = JSON.parse(event.body || '{}');
    } catch {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    try {
        const items = body.items || body.cart || body.cartItems || [];
        
        if (items.length === 0) {
            throw new Error("Cart is empty");
        }

        const squareLineItems = items.map((item, i) => {
            // FIX: Check for catalogObjectId OR item.id
            const squareId = item.catalogObjectId || item.id;

            if (squareId) {
                return {
                    catalogObjectId: String(squareId).trim(),
                    quantity: String(item.quantity || 1)
                };
            }

            const rawPrice = parseFloat(item.price) || 0;
            const cents = rawPrice > 1000 ? Math.round(rawPrice) : Math.round(rawPrice * 100);

            return {
                name: item.name || `Item ${i + 1}`,
                quantity: String(item.quantity || 1),
                basePriceMoney: {
                    amount: cents,
                    currency: 'USD'
                }
            };
        });

        const payload = {
            idempotencyKey: crypto.randomUUID(),
            order: {
                locationId: process.env.SQUARE_LOCATION_ID,
                lineItems: squareLineItems,
                pricingOptions: { autoApplyTaxes: true }
            },
            checkoutOptions: {
                askForShippingAddress: true,
                redirectUrl: 'https://rlpdezines.com/order-complete',
                merchantSupportEmail: 'rlp@rlpdezines.com'
            }
        };

        const response = await squareClient.checkoutApi.createPaymentLink(payload);
        
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ checkoutUrl: response.result.paymentLink.url })
        };

    } catch (error) {
        console.error('💥 FULL ERROR:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                error: 'Checkout failed',
                details: error.message
            })
        };
    }
};
