const axios = require('axios');
const { Resend } = require('resend');
const crypto = require('crypto');
const { Client, Environment } = require('square');

const resend = new Resend(process.env.RESEND_API_KEY);
const squareClient = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: Environment.Production,
});

// DYNAMIC SIGNATURE FIX: Reads the exact domain Square targeted
function isValidSquareSignature(event) {
    const signature = event.headers['x-square-hmacsha256-signature'];
    if (!signature || !process.env.SQUARE_WEBHOOK_SIGNATURE_KEY) return false;
    
    const host = event.headers.host || 'rlpdezines.com';
    const webhookUrl = `https://${host}${event.path}`;
    
    const hmac = crypto.createHmac('sha256', process.env.SQUARE_WEBHOOK_SIGNATURE_KEY);
    hmac.update(webhookUrl + event.body);
    const hash = hmac.digest('base64');
    
    return hash === signature;
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    if (!isValidSquareSignature(event)) {
        console.error("Unauthorized Webhook Attempt: Signature mismatch.");
        return { statusCode: 401, body: 'Unauthorized' };
    }

    try {
        const payload = JSON.parse(event.body);

        if (payload.type === 'payment.updated' && payload.data.object.payment.status === 'COMPLETED') {
            const payment = payload.data.object.payment;
            const orderId = payment.order_id;

            if (!orderId) return { statusCode: 400, body: 'Missing order_id' };

            const orderResponse = await squareClient.ordersApi.retrieveOrder(orderId);
            const order = orderResponse.result.order;
            const lineItems = order.lineItems || [];

            const printfulItems = lineItems.map(item => ({
                external_variant_id: item.sku || item.catalogObjectId,
                quantity: parseInt(item.quantity) || 1,
                name: item.name
            }));

            const recipient = {
                name: payment.shipping_address?.first_name 
                    ? `${payment.shipping_address.first_name} ${payment.shipping_address.last_name}`
                    : 'Customer',
                address1: payment.shipping_address?.address_line_1 || 'Address on file',
                city: payment.shipping_address?.locality || '',
                state_code: payment.shipping_address?.administrative_district_level_1 || '',
                country_code: payment.shipping_address?.country || 'US',
                zip: payment.shipping_address?.postal_code || '',
                email: payment.buyer_email_address || 'rlp@rlpdezines.com',
                phone: payment.shipping_address?.phone_number || ''
            };

            let printfulSuccess = true;

            try {
                const printfulPayload = {
                    external_id: orderId,
                    shipping: "STANDARD",
                    recipient: recipient,
                    items: printfulItems
                };

                await axios.post('https://api.printful.com/orders', printfulPayload, {
                    headers: { 
                        'Authorization': `Bearer ${process.env.PRINTFUL_API_KEY}`,
                        'Content-Type': 'application/json'
                    }
                });
                console.log(`Printful Order Drafted for Square Order: ${orderId}`);
            } catch (printfulError) {
                printfulSuccess = false;
                const errorReason = printfulError.response?.data ? JSON.stringify(printfulError.response.data) : printfulError.message;
                console.error("Printful API Error:", errorReason);

                // DIAGNOSTIC EMAIL: If Printful fails, it emails YOU the exact reason.
                await resend.emails.send({
                    from: 'System <orders@rlpdezines.com>',
                    to: ['rlp@rlpdezines.com'], // Sends to you
                    subject: '🚨 URGENT: Printful Order Failed to Draft',
                    html: `<p>A customer paid for an order, but Printful rejected it.</p><p><strong>Square Order ID:</strong> ${orderId}</p><p><strong>Printful Error:</strong> ${errorReason}</p>`
                });
            }

            // Sends the standard receipt to the customer
            try {
                const totalPaid = (payment.amount_money.amount / 100).toFixed(2);
                const emailHtml = `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #000; color: #fff; padding: 40px; border-radius: 12px; border: 1px solid #1f1f1f;">
                        <h1 style="font-size: 24px; font-weight: 900; letter-spacing: 2px; font-style: italic; margin-bottom: 30px; color:#fff;">RLP DEZINES</h1>
                        <h2 style="font-size: 20px; font-weight: bold; color: #3B82F6; text-transform: uppercase; border-bottom: 1px solid #333; padding-bottom: 15px;">Order Confirmed</h2>
                        <p style="color: #d1d5db;">Your order has been successfully processed.</p>
                        <div style="background-color: #111; padding: 20px; border-radius: 8px; margin: 30px 0; border: 1px solid #222;">
                            <p style="margin: 0 0 10px 0; color: #9ca3af; font-size: 12px; text-transform: uppercase;">Amount Paid</p>
                            <p style="margin: 0; font-size: 28px; font-weight: bold;">$${totalPaid}</p>
                        </div>
                    </div>
                `;

                await resend.emails.send({
                    from: 'RLP Dezines <orders@rlpdezines.com>',
                    to: [recipient.email],
                    subject: 'Receipt from RLP Dezines',
                    html: emailHtml
                });
            } catch (emailError) {
                console.error("Resend API Error:", emailError.message);
            }

            return { statusCode: 200, body: 'Workflow completed.' };
        }

        return { statusCode: 200, body: 'Webhook ignored event type.' };

    } catch (error) {
        console.error("Critical Webhook Failure:", error.message);
        return { statusCode: 200, body: 'Workflow failed but acknowledged.' }; 
    }
};
