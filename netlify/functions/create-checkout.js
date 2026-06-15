// REPLACE THIS BLOCK INSIDE netlify/functions/create-checkout.js
const response = await client.checkoutApi.createPaymentLink({
    idempotencyKey: crypto.randomUUID(),
    // REMOVED: quickPay block
    order: {
        locationId: process.env.SQUARE_LOCATION_ID,
        lineItems: lineItems
    },
    checkoutOptions: {
        askForShippingAddress: true, // This triggers the shipping calculation
        acceptedPaymentMethods: { applePay: true, googlePay: true }
    }
});
