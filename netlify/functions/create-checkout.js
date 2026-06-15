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
        // FIX 1: Look for 'cartItems' as well
        const items = body.items || body.cart || body.cartItems || [];
        
        if (items.length === 0) {
            throw new Error("Cart is empty - payload keys did not match 'items', 'cart', or 'cartItems'");
        }

        const squareLineItems = items.map((item, i) => {
            if (item.catalogObjectId) {
                return {
                    catalogObjectId: String(item.catalogObjectId).trim(),
                    quantity: String(item.quantity || 1)
                };
            }

            // FIX 2: Handle cents vs dollars automatically
            // If the price is > 1000 (like 8900), treat as cents. 
            // If it's small (like 89), multiply by 100.
            const rawPrice = parseFloat(item.price) || 0;
            const cents = rawPrice > 1000 ? Math.round(rawPrice) : Math.round(rawPrice * 100);

            return {
                name: item.name || `Item ${i + 1}`,
                quantity: String(item.quantity || 1),
                basePriceMoney: {
                    amount: BigInt(cents),
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
