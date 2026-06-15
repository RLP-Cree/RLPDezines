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

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: 'Method Not Allowed' };
    }

    try {
        const body = JSON.parse(event.body);
        const items = body.items || body.cart || [];

        if (items.length === 0) {
            throw new Error("The cart is empty. Cannot generate a checkout link.");
        }

        const squareLineItems = items.map(item => {
            // If pulling from Square's item catalog:
            if (item.catalogObjectId || item.id) {
                return {
                    catalogObjectId: item.catalogObjectId || item.id,
                    quantity: item.quantity.toString()
                };
            }
            
            // If passing custom items from your frontend:
            return {
                name: item.name,
                quantity: item.quantity.toString(),
                basePriceMoney: {
                    // ── THE BIGINT FIX ── 
                    // Square strictly requires money to be wrapped in a BigInt format
                    amount: BigInt(Math.round(parseFloat(item.price) * 100)), 
                    currency: 'USD'
                }
            };
        });

        const checkoutPayload = {
            idempotencyKey: crypto.randomUUID(), 
            order: {
                locationId: process.env.SQUARE_LOCATION_ID,
                lineItems: squareLineItems,
                
                // ── THE TAX FIX ──
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
        
        // Added a custom stringifier so BigInt errors don't crash the Netlify logs
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
