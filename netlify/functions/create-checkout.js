const { Client, Environment } = require('square');
const crypto = require('crypto');

// Hardcoded to Production so it never conflicts with your live token
const client = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: Environment.Production, 
});

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        const { cartItems } = JSON.parse(event.body);

        // Format the cart items into Square's strict "Line Item" format
        const lineItems = cartItems.map(item => ({
            name: item.name,
            quantity: item.quantity.toString(),
            basePriceMoney: {
                amount: Number(item.price), // Price is securely handled in cents
                currency: 'USD'
            }
        }));

        // Send the single request object to Square (Order format only)
        const response = await client.checkoutApi.createPaymentLink({
            idempotencyKey: crypto.randomUUID(),
            order: {
                locationId: process.env.SQUARE_LOCATION_ID,
                lineItems: lineItems
            },
            checkoutOptions: {
                askForShippingAddress: true,
                acceptedPaymentMethods: { applePay: true, googlePay: true }
            }
        });

        // Return the secure Square Checkout URL back to the website
        return {
            statusCode: 200,
            body: JSON.stringify({ url: response.result.paymentLink.url })
        };
        
    } catch (error) {
        // Advanced error catching to pinpoint any issues
        console.error("Checkout Error:", error.message);
        let errorDetails = error.message;
        if (error.errors && error.errors.length > 0) {
            errorDetails = error.errors[0].detail || error.errors[0].code || error.message;
        }
        
        return { 
            statusCode: 500, 
            body: JSON.stringify({ error: 'Failed to create checkout', details: errorDetails }) 
        };
    }
};
