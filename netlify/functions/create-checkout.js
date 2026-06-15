const { Client, Environment } = require('square');
const crypto = require('crypto'); // Built into Node to generate unique order keys

const squareClient = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: Environment.Production,
});

exports.handler = async (event) => {
    // ── CORS SETUP: Ensures your frontend website can safely talk to this backend ──
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };

    // Handle preflight requests from browsers
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    // Block non-POST requests
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: 'Method Not Allowed' };
    }

    try {
        // Parse the cart items coming from your website
        const body = JSON.parse(event.body);
        const items = body.items || body.cart || [];

        if (items.length === 0) {
            throw new Error("The cart is empty. Cannot generate a checkout link.");
        }

        // Map your frontend cart items to Square's exact line-item format
        const squareLineItems = items.map(item => {
            // IF you are passing Square Catalog IDs from your get-products function:
            if (item.catalogObjectId || item.id) {
                return {
                    catalogObjectId: item.catalogObjectId || item.id,
                    quantity: item.quantity.toString()
                };
            }
            
            // IF you are passing raw custom/ad-hoc items (just name and price):
            return {
                name: item.name,
                quantity: item.quantity.toString(),
                basePriceMoney: {
                    amount: Math.round(parseFloat(item.price) * 100), // Square requires cents (e.g., $28.50 = 2850)
                    currency: 'USD'
                }
            };
        });

        // ── BUILD THE CHECKOUT PAYLOAD ──
        const checkoutPayload = {
            idempotencyKey: crypto.randomUUID(), // Prevents duplicate orders if a customer double-clicks
            order: {
                locationId: process.env.SQUARE_LOCATION_ID,
                lineItems: squareLineItems,
                
                // ── THE TAX FIX ──
                // This forces Square to look at your dashboard rules and apply local sales tax
                pricingOptions: {
                    autoApplyTaxes: true
                }
            },
            checkoutOptions: {
                // ── THE SHIPPING PROTECTOR ──
                // Forces the Square page to collect a physical address (Required for Printful!)
                askForShippingAddress: true,
                
                // Bounces the customer straight back to your site after payment clears
                redirectUrl: 'https://rlpdezines.com',
                merchantSupportEmail: 'rlp@rlpdezines.com'
            }
        };

        // Fire the payload to Square and generate the secure checkout URL
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
        
        // Drill down to get exact Square API errors if they exist
        const errorMessage = error.errors ? JSON.stringify(error.errors) : error.message;
        
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Failed to create checkout link', details: errorMessage })
        };
    }
};
