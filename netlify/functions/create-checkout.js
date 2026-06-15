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
        console.log('Received cart payload:', JSON.stringify(body, null, 2)); // ← Important for debugging

        const items = body.items || body.cart || [];

        if (items.length === 0) {
            throw new Error("Cart is empty");
        }

        const squareLineItems = items.map((item, index) => {
            console.log(`Processing item ${index}:`, item);

            if (item.catalogObjectId) {
                return {
                    catalogObjectId: item.catalogObjectId,
                    quantity: String(item.quantity || 1),
                };
            }

            // Custom item
            const rawPrice = String(item.price || "0").replace(/[^0-9.]/g, '');
            const amountInCents = Math.round(parseFloat(rawPrice) * 100);

            if (isNaN(amountInCents) || amountInCents <= 0) {
                throw new Error(`Invalid price for item "${item.name || 'Unknown'}": ${item.price}`);
            }

            return {
                name: item.name || `Item ${index + 1}`,
                quantity: String(item.quantity || 1),
                basePriceMoney: {
                    amount: BigInt(amountInCents),
                    currency: 'USD'
                },
            };
        });

        const checkoutPayload = {
            idempotencyKey: crypto.randomUUID(),
            order: {
                locationId: process.env.SQUARE_LOCATION_ID,
                lineItems: squareLineItems,
                pricingOptions: { autoApplyTaxes: true },
            },
            checkoutOptions: {
                askForShippingAddress: true,
                redirectUrl: 'https://rlpdezines.com',
                merchantSupportEmail: 'rlp@rlpdezines.com',
            },
        };

        console.log('Sending to Square:', JSON.stringify(checkoutPayload, (k, v) => 
            typeof v === 'bigint' ? v.toString() : v, 2));

        const response = await squareClient.checkoutApi.createPaymentLink(checkoutPayload);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                checkoutUrl: response.result.paymentLink.url,
                orderId: response.result.paymentLink.orderId,
            }),
        };

    } catch (error) {
        console.error('=== FULL CHECKOUT ERROR ===');
        console.error(error);

        let details = error.message;

        if (error.errors && Array.isArray(error.errors)) {
            details = error.errors.map(e => ({
                code: e.code,
                detail: e.detail,
                field: e.field
            }));
            console.error('Square API Errors:', details);
        }

        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                error: 'Failed to create checkout link',
                details: details
            }),
        };
    }
};
