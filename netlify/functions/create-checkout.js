const { SquareClient, SquareEnvironment } = require('square');
const crypto = require('crypto');

const squareClient = new SquareClient({
    token: process.env.SQUARE_ACCESS_TOKEN,        // Newer SDK prefers 'token'
    environment: SquareEnvironment.Production,     // Use SquareEnvironment
});

exports.handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: 'Method Not Allowed' };
    }

    try {
        const body = JSON.parse(event.body || '{}');
        const items = body.items || body.cart || [];

        if (items.length === 0) {
            throw new Error("The cart is empty. Cannot generate a checkout link.");
        }

        const squareLineItems = items.map(item => {
            // Case 1: Using a Square Catalog item
            if (item.catalogObjectId) {
                return {
                    catalogObjectId: item.catalogObjectId,
                    quantity: String(item.quantity || 1),
                };
            }

            // Case 2: Custom/ad-hoc item
            const rawPrice = String(item.price || "0").replace(/[^0-9.]/g, '');
            const amountInCents = Math.round(parseFloat(rawPrice) * 100);

            if (isNaN(amountInCents) || amountInCents <= 0) {
                throw new Error(`Invalid price for item: ${item.name || 'Unknown'}`);
            }

            return {
                name: item.name || "Custom Item",
                quantity: String(item.quantity || 1),
                basePriceMoney: {
                    amount: BigInt(amountInCents),   // Must be BigInt
                    currency: 'USD'
                },
            };
        });

        const checkoutPayload = {
            idempotencyKey: crypto.randomUUID(),
            order: {
                locationId: process.env.SQUARE_LOCATION_ID,
                lineItems: squareLineItems,
                pricingOptions: {
                    autoApplyTaxes: true,
                },
            },
            checkoutOptions: {
                askForShippingAddress: true,
                redirectUrl: 'https://rlpdezines.com',
                merchantSupportEmail: 'rlp@rlpdezines.com',
            },
        };

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
        console.error('Checkout Generation Error:', error);

        let errorDetails = error.message;

        if (error.errors) {
            errorDetails = error.errors.map(err => ({
                code: err.code,
                detail: err.detail,
                field: err.field,
            }));
        }

        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                error: 'Failed to create checkout link',
                details: errorDetails,
            }),
        };
    }
};
