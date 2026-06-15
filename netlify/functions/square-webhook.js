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

        // ── Verify Webhook Signature ──
        const signature = event.headers['x-square-hmacsha256-signature'];
        // Updated to match your exact Square Dashboard Notification URL
        const webhookUrl = 'https://rlpdezines.netlify.app/.netlify/functions/square-webhook';
        const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;

        if (!WebhooksHelper.isValidWebhookEventSignature(event.body, signature, signatureKey, webhookUrl)) {
            console.error("Unauthorized webhook attempt. Signature check failed.");
            return { statusCode: 401, body: 'Unauthorized' };
        }

        const payload = JSON.parse(event.body);

        if ((payload.type === 'payment.updated' || payload.type === 'payment.created') && payload.data.object.payment.status === 'COMPLETED') {
            const payment = payload.data.object.payment;
            const orderId = payment.order_id;

            if (!orderId) throw new Error("Payment was completed, but Square did not attach an order_id.");

            const orderResponse = await squareClient.ordersApi.retrieveOrder(orderId);
            const order = orderResponse.result.order;
            const lineItems = order.lineItems || [];

            const printfulItems = lineItems.map(item => ({
                external_variant_id: item.sku || item.catalogObjectId,
                quantity: parseInt(item.quantity) || 1,
                name: item.name
            }));

            const fulfillment = order.fulfillments?.[0] || {};
            const shipmentDetails = fulfillment.shipmentDetails || {};
            const orderRecipient = shipmentDetails.recipient || {};
            const orderAddress = orderRecipient.address || {};
            const payAddress = payment.shipping_address || {};

            const recipient = {
                name: orderRecipient.displayName || (payAddress.first_name ? `${payAddress.first_name} ${payAddress.last_name}` : 'Customer'),
                address1: orderAddress.addressLine1 || payAddress.address_line_1 || 'Address on file',
                city: orderAddress.locality || payAddress.locality || '',
                state_code: orderAddress.administrativeDistrictLevel1 || payAddress.administrative_district_level_1 || '',
                country_code: orderAddress.country || payAddress.country || 'US',
                zip: orderAddress.postalCode || payAddress.postal_code || '',
                email: payment.buyer_email_address || 'rlp@rlpdezines.com',
                phone: orderRecipient.phoneNumber || payAddress.phone_number || ''
            };

            let firstHookProcessed = false;

            // ── SUBMIT & AUTO-FULFILL VIA PRINTFUL ──
            try {
                const printfulPayload = {
                    external_id: orderId,
                    shipping: "STANDARD",
                    recipient: recipient,
                    items: printfulItems
                };

                const printfulResponse = await axios.post('https://api.printful.com/orders', printfulPayload, {
                    headers: { 
                        'Authorization': `Bearer ${process.env.PRINTFUL_API_KEY}`,
                        'Content-Type': 'application/json'
                    }
                });

                const printfulOrderId = printfulResponse.data?.result?.id;

                if (printfulOrderId) {
                    await axios.post(`https://api.printful.com/orders/${printfulOrderId}/confirm`, {}, {
                        headers: { 
                            'Authorization': `Bearer ${process.env.PRINTFUL_API_KEY}`,
                            'Content-Type': 'application/json'
                        }
                    });
                    console.log(`Printful Order ${printfulOrderId} officially submitted to production!`);
                    firstHookProcessed = true;
                }
            } catch (printfulError) {
                const errorData = printfulError.response?.data || {};
                const errorReason = JSON.stringify(errorData) || printfulError.message;
                
                if (errorReason.includes("already exists") || errorData.error?.message?.includes("already exists") || errorData.api_error_code === "OR-13") {
                    console.log(`Duplicate event for Square Order ${orderId} ignored safely.`);
                } else {
                    await resend.emails.send({
                        from: 'System <orders@rlpdezines.com>',
                        to: ['rlp@rlpdezines.com'],
                        subject: '🚨 URGENT: Printful Fulfillment Error',
                        html: `<p>Square took the payment, but the Printful pipeline hit a roadblock.</p><p><strong>Square Order ID:</strong> ${orderId}</p><p><strong>Printful Error:</strong> ${errorReason}</p>`
                    });
                }
            }

            // ── PREMIUM CUSTOMER CONFIRMATION EMAIL ──
            if (firstHookProcessed || !event.headers['x-square-retry-count'] || event.headers['x-square-retry-count'] === '0') {
                try {
                    const itemsHtml = lineItems.map(item => {
                        const totalLinePrice = item.totalMoney ? (item.totalMoney.amount / 100).toFixed(2) : "0.00";
                        return `
                            <tr>
                                <td style="padding: 12px 0; border-bottom: 1px solid #1f1f1f; color: #ffffff;">
                                    <strong style="color: #ffffff;">${item.name}</strong>
                                    <div style="color: #9ca3af; font-size: 12px;">Qty: ${item.quantity}</div>
                                </td>
                                <td style="padding: 12px 0; border-bottom: 1px solid #1f1f1f; color: #ffffff; text-align: right;">$${totalLinePrice}</td>
                            </tr>`;
                    }).join('');

                    const totalTax = order.totalTaxMoney ? (order.totalTaxMoney.amount / 100).toFixed(2) : "0.00";
                    const totalGross = order.totalMoney ? (order.totalMoney.amount / 100).toFixed(2) : "0.00";
                    const totalServiceCharges = order.totalServiceChargeMoney ? order.totalServiceChargeMoney.amount : 0;
                    const calculatedSubtotal = ((order.totalMoney?.amount || 0) - (order.totalTaxMoney?.amount || 0) - totalServiceCharges) / 100;
                    const calculatedShipping = (totalServiceCharges / 100).toFixed(2);

                    await resend.emails.send({
                        from: 'RLP Dezines <orders@rlpdezines.com>',
                        to: [recipient.email],
                        subject: 'Order Confirmed - RLP Dezines',
                        html: `<div style="background:#000; color:#fff; padding:20px;"><h1>RLP DEZINES</h1><p>Order Confirmed.</p><table>${itemsHtml}</table><p>Total: $${totalGross}</p></div>`
                    });
                } catch (emailError) {
                    console.error("Resend API Error:", emailError.message);
                }
            }
            return { statusCode: 200, body: 'Workflow completed successfully.' };
        }
        return { statusCode: 200, body: 'Webhook ignored event type.' };
    } catch (fatalError) {
        console.error("Fatal Error:", fatalError);
        return { statusCode: 200, body: 'Workflow crashed.' }; 
    }
};
