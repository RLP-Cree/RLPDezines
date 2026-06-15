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

    try {
        const body = JSON.parse(event.body || '{}');
        console.log('📥 Incoming payload:', JSON.stringify(body, null, 2));

        const items = body.items || body.cart || [];
        if (items.length === 0) throw new Error("Cart is empty");

        const squareLineItems = items.map((item, i) => {
            console.log(`Processing item ${i}:`, item);

            if (item.catalogObjectId) {
                return { catalogObjectId: item.catalogObjectId, quantity: String(item.quantity || 1) };
            }

            const rawPrice = String(item.price || 0).replace(/[^0-9.]/g, '');
            const cents = Math.round(parseFloat(rawPrice) * 100);

            if (!cents || isNaN(cents)) throw new Error(`Bad price on item: ${item.name}`);

            return {
                name: item.name || `Item ${i+1}`,
                quantity: String(item.quantity || 1),
                basePriceMoney: {
                    amount: BigInt(cents),
                    currency: 'USD'
                }
            };
        });

        if (!process.env.SQUARE_LOCATION_ID) {
            throw new Error("SQUARE_LOCATION_ID environment variable is missing");
        }

        const payload = {
            idempotencyKey: crypto.randomUUID(),
            order: {
                locationId: process.env.SQUARE_LOCATION_ID,
                lineItems: squareLineItems,
                pricingOptions: { autoApplyTaxes: true }
            },
            checkoutOptions: {
                askForShippingAddress: true,
                redirectUrl: 'https://rlpdezines.com',
                merchantSupportEmail: 'rlp@rlpdezines.com'
            }
        };

        console.log('🚀 Sending to Square:', JSON.stringify(payload, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));

        const response = await squareClient.checkoutApi.createPaymentLink(payload);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                checkoutUrl: response.result.paymentLink.url
            })
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
