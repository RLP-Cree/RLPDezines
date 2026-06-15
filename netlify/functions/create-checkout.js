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

        // Keep a running tally of total items for dynamic shipping
        let totalQuantity = 0;

        const squareLineItems = items.map((item, i) => {
            const squareId = item.catalogObjectId || item.id;
            
            // Add to our master shipping count
            totalQuantity += parseInt(item.quantity || 1, 10);

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
                    amount: BigInt(cents),
                    currency: 'USD'
                }
            };
        });

        // ── THE DYNAMIC INCREMENTAL SHIPPING CALCULATOR ──
        // Calculates $13.50 for the first item, plus $4.00 for every additional item.
        let calculatedShippingDollars = 0;
        if (totalQuantity > 0) {
            calculatedShippingDollars = 13.50 + ((totalQuantity - 1) * 4.00);
        }
        const shippingCents = Math.round(calculatedShippingDollars * 100);

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
                merchantSupportEmail: 'rlp@rlpdezines.com',
                
                // ── THE SHIPPING INJECTION ──
                shippingFee: {
                    name: 'Standard Shipping',
                    charge: {
                        amount: BigInt(shippingCents),
                        currency: 'USD'
                    }
                }
            }
        };

        console.log('🚀 Final Payload Flight Check:', JSON.stringify(payload, (k, v) =>
            typeof v === 'bigint' ? v.toString() : v, 2));

        const response = await squareClient.checkoutApi.createPaymentLink(payload);
        
        const paymentLink = response?.result?.paymentLink;
        if (!paymentLink?.url) throw new Error("Square returned no payment link URL");

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
