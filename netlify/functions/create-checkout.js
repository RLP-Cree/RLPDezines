const { SquareClient, SquareEnvironment } = require('square');
const crypto = require('crypto');

const squareClient = new SquareClient({
    token: process.env.SQUARE_ACCESS_TOKEN,
    environment: SquareEnvironment.Production,
});

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };

    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

    // Parse body early with a clean error
    let body;
    try {
        body = JSON.parse(event.body || '{}');
    } catch {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    try {
        console.log('📥 Incoming payload:', JSON.stringify(body, null, 2));

        const items = body.items || body.cart || [];
        if (items.length === 0) throw new Error("Cart is empty");

        if (!process.env.SQUARE_LOCATION_ID) {
            throw new Error("SQUARE_LOCATION_ID environment variable is missing");
        }

        const squareLineItems = items.map((item, i) => {
            console.log(`Processing item ${i}:`, item);

            if (item.catalogObjectId) {
                if (typeof item.catalogObjectId !== 'string' || !item.catalogObjectId.trim()) {
                    throw new Error(`Invalid catalogObjectId on item ${i}`);
                }
                return {
                    catalogObjectId: item.catalogObjectId.trim(),
                    quantity: String(item.quantity || 1)
                };
            }

            const rawPrice = String(item.price || 0).replace(/[^0-9.]/g, '');
            const cents = Math.round(parseFloat(rawPrice) * 100);

            if (!cents || isNaN(cents)) throw new Error(`Bad price on item: ${item.name}`);

            return {
                name: item.name || `Item ${i + 1}`,
                quantity: String(item.quantity || 1),
                basePriceMoney: {
                    amount: BigInt(cents), // Use plain `cents` if square SDK < 35.x
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

        console.log('🚀 Sending to Square:', JSON.stringify(payload, (k, v) =>
            typeof v === 'bigint' ? v.toString() : v, 2));

        const response = await squareClient.checkoutApi.createPaymentLink(payload);

        const paymentLink = response?.result?.paymentLink;
        if (!paymentLink?.url) throw new Error("Square returned no payment link URL");

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ checkoutUrl: paymentLink.url })
        };

    } catch (error) {
        console.error('💥 FULL ERROR:', error);
        if (error.errors) console.error('Square Errors:', JSON.stringify(error.errors, null, 2));

        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                error: 'Checkout failed',
                details: error.message || error.errors || 'Unknown error - check function logs'
            })
        };
    }
};
