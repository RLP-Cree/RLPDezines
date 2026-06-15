const axios = require('axios');
const { Resend } = require('resend');
const { Client, Environment, WebhooksHelper } = require('square');

const resend = new Resend(process.env.RESEND_API_KEY);
const squareClient = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: Environment.Production,
});

exports.handler = async (event) => {
    try {
        if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

        // ── Fix: Verify Webhook Signature using raw event.body ──
        const signature = event.headers['x-square-hmacsha256-signature'];
        const webhookUrl = 'https://rlpdezines.com/.netlify/functions/square-webhook';
        const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;

        // Ensure we pass event.body as a raw string
        if (!WebhooksHelper.isValidWebhookEventSignature(event.body, signature, signatureKey, webhookUrl)) {
            console.error("Unauthorized webhook attempt. Signature check failed.");
            return { statusCode: 401, body: 'Unauthorized' };
        }

        // Parse only after the signature has been validated
        const payload = JSON.parse(event.body);

        if ((payload.type === 'payment.updated' || payload.type === 'payment.created') && payload.data.object.payment.status === 'COMPLETED') {
            const payment = payload.data.object.payment;
            const orderId = payment.order_id;

            if (!orderId) throw new Error("Payment was completed, but Square did not attach an order_id.");

            const orderResponse = await squareClient.ordersApi.retrieveOrder(orderId);
            const order = orderResponse.result.order;
            const lineItems = order.lineItems || [];

            // ... (Your existing mapping and Printful logic remains the same)

            const printfulItems = lineItems.map(item => ({
                external_variant_id: item.sku || item.catalogObjectId,
                quantity: parseInt(item.quantity) || 1,
                name: item.name
            }));

            // ... (Continue with your existing Printful submission and Email confirmation logic)
            // Ensure you keep your existing error handling for duplicate events!
            
            return { statusCode: 200, body: 'Workflow completed successfully.' };
        }

        return { statusCode: 200, body: 'Webhook ignored event type.' };

    } catch (fatalError) {
        console.error("Fatal Error:", fatalError);
        return { statusCode: 200, body: 'Workflow crashed but acknowledged.' }; 
    }
};
