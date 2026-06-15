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
        console.log('📥 Incoming Payload Check:', JSON.stringify(body, null, 2));

        const items = body.items || body.cart || body.cartItems || [];
        if (items.length === 0) throw new Error("Cart is empty");

        const squareLineItems = items.map((item, i) => {
            const squareId = item.catalogObjectId || item.id;

            // 1. Core Path: If it has an ID, pass it cleanly to Square's catalog registry
            if (squareId) {
                return {
                    catalogObjectId: String(squareId).trim(),
                    quantity: String(item.quantity || 1)
                };
            }

            // 2. Fallback Path: Defensive price parser if IDs ever vanish
            const rawPrice = parseFloat(item.price) || 0;
            // Handle raw cents (8900) vs decimal values (89.00) safely
            const cents = rawPrice > 1000 ? Math.round(rawPrice) : Math.round(rawPrice * 100);

            return {
                name: item.name || `Item ${i + 1}`,
                quantity: String(item.quantity || 1),
                basePriceMoney: {
                    // CONVERT TO BIGINT: Prevents Square's internal SDK typing validation from crashing
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
                // THIS FORCES AUTOMATIC SALES TAX APPLICATION FROM YOUR DASHBOARD
                pricingOptions: { autoApplyTaxes: true }
            },
            checkoutOptions: {
                askForShippingAddress: true,
                redirectUrl: 'https://rlpdezines.com/order-complete',
                merchantSupportEmail: 'rlp@rlpdezines.com'
            }
        };

        console.log('🚀 Final Payload Flight Check:', JSON.stringify(payload, (k, v) =>
            typeof v === 'bigint' ? v.toString() : v, 2));

        const response = await squareClient.checkoutApi.createPaymentLink(payload);
        
        const paymentLink = response?.result?.paymentLink;
        if (!paymentLink?.url) throw new Error("Square returned no payment link URL");

        // ── THE FRONTEND RESPONSE FIX ──
        // Sending the link back under every common label so the frontend catches it
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ 
                url: paymentLink.url,           
                checkoutUrl: paymentLink.url,   
                checkoutLink: paymentLink.url,
                orderId: paymentLink.orderId
            })
        };

    } catch (error) {
        console.error('💥 FULL ERROR ENCOUNTERED:', error);
        
        const errorDetails = error.errors 
            ? JSON.stringify(error.errors, (k, v) => typeof v === 'bigint' ? v.toString() : v) 
            : error.message;

        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                error: 'Checkout failed',
                details: errorDetails
            })
        };
    }
};
