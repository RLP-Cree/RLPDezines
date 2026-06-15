const { Client, Environment } = require('square');
const crypto = require('crypto');

const squareClient = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: Environment.Production,
});

exports.handler = async (event) => {
    // ── CORS SETUP ──
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };

    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

    try {
        const body = JSON.parse(event.body);
        const items = body.items || body.cart || [];

        if (items.length === 0) throw new Error("The cart is empty. Cannot generate a checkout link.");

        const squareLineItems = items.map(item => {
            // 1. If your frontend explicitly provides a Square Catalog ID, use it safely:
            if (item.catalogObjectId) {
                return {
                    catalogObjectId: item.catalogObjectId,
                    quantity: String(item.quantity || 1)
                };
            }
            
            // 2. The Regex Price Cleaner (Strips out '$', ',', or any letters)
            const rawPrice = String(item.price || "0").replace(/[^0-9.]/g, '');
            const amountInCents = Math.round(parseFloat(rawPrice) * 100);

            // 3. Force Custom Ad-Hoc Mapping (Bypasses the Catalog ID crash entirely)
            return {
                name: item.name || "Custom Item",
                quantity: String(item.quantity || 1),
                basePriceMoney: {
                    amount: BigInt(amountInCents),
                    currency: 'USD'
                }
            };
        });

        const checkoutPayload = {
            idempotencyKey: crypto.randomUUID(), 
            order: {
                locationId: process.env.SQUARE_LOCATION_ID,
                lineItems: squareLineItems,
                
                // ── THE TAX FIX IS STILL HERE ──
                pricingOptions: {
                    autoApplyTaxes: true
                }
            },
            checkoutOptions: {
                askForShippingAddress: true,
                redirectUrl: 'https://rlpdezines.com',
                merchantSupportEmail: 'rlp@rlpdezines.com'
            }
        };

        const response = await squareClient.checkoutApi.createPaymentLink(checkoutPayload);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                checkoutUrl: response.result.paymentLink.url,
                orderId: response.result.paymentLink.orderId
            })
        };

    } catch (error) {
        console.error('Checkout Generation Error:', error);
        
        const errorMessage = error.errors 
            ? JSON.stringify(error.errors, (key, value) => typeof value === 'bigint' ? value.toString() : value) 
            : error.message;
        
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to create checkout link', details: errorMessage })
        };
    }
};
