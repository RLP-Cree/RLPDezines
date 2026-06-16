const axios = require('axios');
const { Resend } = require('resend');
const { Client, Environment, WebhooksHelper } = require('square');

const resend = new Resend(process.env.RESEND_API_KEY);
const squareClient = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: Environment.Production,
});

// Track processed orders to prevent duplicate fulfillments in warm server instances
const processedOrders = new Map();

exports.handler = async (event) => {
    console.log("DEBUG - Signature Header received:", event.headers['x-square-hmacsha256-signature']);
    
    try {
        if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

        // ── Verify Webhook Signature ──
        const signature = event.headers['x-square-hmacsha256-signature'];
        const webhookUrl = process.env.WEBHOOK_URL || 'https://rlpdezines.netlify.app/.netlify/functions/square-webhook';
        const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;

        if (!webhookUrl) {
            console.error("WEBHOOK_URL environment variable is not set");
            return { statusCode: 500, body: 'Configuration error' };
        }

        if (!WebhooksHelper.isValidWebhookEventSignature(event.body, signature, signatureKey, webhookUrl)) {
            console.error("Unauthorized webhook attempt. Signature check failed.");
            return { statusCode: 401, body: 'Unauthorized' };
        }

        const payload = JSON.parse(event.body);

        if ((payload.type === 'payment.updated' || payload.type === 'payment.created') && payload.data.object.payment.status === 'COMPLETED') {
            const payment = payload.data.object.payment;
            const orderId = payment.order_id;

            if (!orderId) throw new Error("Payment was completed, but Square did not attach an order_id.");

            // Check memory cache for fast duplicate rejection
            if (processedOrders.has(orderId)) {
                console.log(`Order ${orderId} already processed in this function instance. Skipping.`);
                return { statusCode: 200, body: 'Duplicate webhook ignored.' };
            }

            const orderResponse = await squareClient.ordersApi.retrieveOrder(orderId);
            const order = orderResponse.result.order;
            const lineItems = order.lineItems || [];

            // Validate that we have items to fulfill
            if (!lineItems || lineItems.length === 0) {
                console.warn(`Order ${orderId} has no line items. Skipping fulfillment.`);
                return { statusCode: 200, body: 'No items to fulfill.' };
            }

            const printfulItems = lineItems.map(item => ({
                external_variant_id: item.sku || item.catalogObjectId || 'unknown-item',
                quantity: parseInt(item.quantity) || 1,
                name: item.name
            }));

            const fulfillment = order.fulfillments?.[0] || {};
            const shipmentDetails = fulfillment.shipmentDetails || {};
            const orderRecipient = shipmentDetails.recipient || {};
            const orderAddress = orderRecipient.address || {};
            const payAddress = payment.shipping_address || {};

            // Validate email address
            const customerEmail = payment.buyer_email_address?.trim();
            if (!customerEmail || !customerEmail.includes('@')) {
                console.warn(`Order ${orderId} has invalid customer email. Using fallback.`);
            }

            const recipient = {
                name: orderRecipient.displayName || (payAddress.first_name ? `${payAddress.first_name} ${payAddress.last_name}` : 'Customer'),
                address1: orderAddress.addressLine1 || payAddress.address_line_1 || 'Address on file',
                city: orderAddress.locality || payAddress.locality || '',
                state_code: orderAddress.administrativeDistrictLevel1 || payAddress.administrative_district_level_1 || '',
                country_code: orderAddress.country || payAddress.country || 'US',
                zip: orderAddress.postalCode || payAddress.postal_code || '',
                email: customerEmail || 'rlp@rlpdezines.com',
                phone: orderRecipient.phoneNumber || payAddress.phone_number || ''
            };

            let isFreshOrder = false;

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
                    console.log(`Printful Order ${printfulOrderId} officially submitted to production for Square Order ${orderId}!`);
                    isFreshOrder = true; // Flag it as a brand new success so the email fires
                    processedOrders.set(orderId, { timestamp: Date.now(), printfulOrderId });
                }
            } catch (printfulError) {
                const errorData = printfulError.response?.data || {};
                const errorReason = JSON.stringify(errorData) || printfulError.message;
                
                if (errorReason.includes("already exists") || errorData.error?.message?.includes("already exists") || errorData.api_error_code === "OR-13") {
                    console.log(`Duplicate event for Square Order ${orderId} detected. Exiting safely without sending duplicate emails.`);
                    
                    // EXIT THE FUNCTION ENTIRELY! This prevents the spam emails.
                    return { statusCode: 200, body: 'Duplicate webhook ignored safely.' };
                    
                } else {
                    console.error(`Printful API Error for Order ${orderId}:`, errorReason);
                    isFreshOrder = true; // It IS a new order, Printful just errored out (like the sync variant bug). We still want to email the customer their receipt!
                    
                    try {
                        await resend.emails.send({
                            from: 'System <orders@rlpdezines.com>',
                            to: ['rlp@rlpdezines.com'],
                            subject: '🚨 URGENT: Printful Fulfillment Error',
                            html: `
                                <div style="font-family: Arial, sans-serif; color: #333;">
                                    <h2>Printful Fulfillment Error</h2>
                                    <p>Square took the payment, but the Printful pipeline hit a roadblock.</p>
                                    <p><strong>Square Order ID:</strong> ${orderId}</p>
                                    <p><strong>Customer Email:</strong> ${recipient.email}</p>
                                    <p><strong>Error Details:</strong></p>
                                    <pre style="background: #f4f4f4; padding: 10px; border-radius: 5px; overflow-x: auto;">${errorReason}</pre>
                                    <p><strong>Action Required:</strong> Please investigate and manually confirm this order if necessary.</p>
                                </div>
                            `
                        });
                    } catch (emailError) {
                        console.error("Failed to send error notification email:", emailError.message);
                    }
                }
            }

            // ── PREMIUM CUSTOMER CONFIRMATION EMAIL ──
            if (isFreshOrder) {
                try {
                    const itemsHtml = lineItems.map(item => {
                        const totalLinePrice = item.totalMoney ? (Number(item.totalMoney.amount) / 100).toFixed(2) : "0.00";
                        return `
                            <tr>
                                <td style="padding: 12px 0; border-bottom: 1px solid #1f1f1f; color: #ffffff;">
                                    <strong style="color: #ffffff;">${item.name}</strong>
                                    <div style="color: #9ca3af; font-size: 12px;">Qty: ${item.quantity}</div>
                                </td>
                                <td style="padding: 12px 0; border-bottom: 1px solid #1f1f1f; color: #ffffff; text-align: right;">$${totalLinePrice}</td>
                            </tr>`;
                    }).join('');

                    const totalTax = order.totalTaxMoney ? (Number(order.totalTaxMoney.amount) / 100).toFixed(2) : "0.00";
                    const totalGross = order.totalMoney ? (Number(order.totalMoney.amount) / 100).toFixed(2) : "0.00";
                    const totalServiceCharges = order.totalServiceChargeMoney ? Number(order.totalServiceChargeMoney.amount) : 0;
                    const calculatedSubtotal = ((Number(order.totalMoney?.amount) || 0) - (Number(order.totalTaxMoney?.amount) || 0) - totalServiceCharges) / 100;
                    const calculatedShipping = (totalServiceCharges / 100).toFixed(2);

                    await resend.emails.send({
                        from: 'RLP Dezines <orders@rlpdezines.com>',
                        to: [recipient.email],
                        subject: 'Order Confirmed - RLP Dezines',
                        html: `
                            <div style="background:#000; color:#fff; padding:20px; font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                                <h1 style="margin: 0 0 20px 0; color: #fff;">RLP DEZINES</h1>
                                <p style="font-size: 16px; margin: 0 0 20px 0;">Your order has been confirmed and is being prepared for shipment.</p>
                                
                                <table style="width: 100%; border-collapse: collapse;">
                                    <thead>
                                        <tr style="border-bottom: 2px solid #fff;">
                                            <th style="padding: 12px 0; text-align: left; color: #fff;">Item</th>
                                            <th style="padding: 12px 0; text-align: right; color: #fff;">Price</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${itemsHtml}
                                    </tbody>
                                </table>
                                
                                <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #333;">
                                    <p style="margin: 8px 0; display: flex; justify-content: space-between;"><span>Subtotal:</span> <span>$${calculatedSubtotal.toFixed(2)}</span></p>
                                    <p style="margin: 8px 0; display: flex; justify-content: space-between;"><span>Shipping:</span> <span>$${calculatedShipping}</span></p>
                                    <p style="margin: 8px 0; display: flex; justify-content: space-between;"><span>Tax:</span> <span>$${totalTax}</span></p>
                                    <p style="margin: 16px 0; font-size: 18px; font-weight: bold; display: flex; justify-content: space-between;"><span>Total:</span> <span>$${totalGross}</span></p>
                                </div>
                                
                                <div style="margin-top: 20px; padding: 15px; background: #1f1f1f; border-radius: 5px;">
                                    <p style="margin: 0 0 8px 0;"><strong>Shipping To:</strong></p>
                                    <p style="margin: 0; color: #9ca3af;">${recipient.name}</p>
                                    <p style="margin: 0; color: #9ca3af;">${recipient.address1}</p>
                                    <p style="margin: 0; color: #9ca3af;">${recipient.city}, ${recipient.state_code} ${recipient.zip}</p>
                                    <p style="margin: 0; color: #9ca3af;">${recipient.country_code}</p>
                                </div>
                                
                                <p style="margin-top: 20px; font-size: 12px; color: #9ca3af;">Thank you for your purchase! You'll receive a tracking number via email once your order ships.</p>
                            </div>
                        `
                    });
                    console.log(`Confirmation email sent to ${recipient.email} for order ${orderId}`);
                } catch (emailError) {
                    console.error("Resend API Error:", emailError.message);
                }
            }
            return { statusCode: 200, body: 'Workflow completed successfully.' };
        }
        return { statusCode: 200, body: 'Webhook ignored event type.' };
    } catch (fatalError) {
        console.error("Fatal Error:", fatalError);
        return { statusCode: 500, body: JSON.stringify({ error: fatalError.message }) }; 
    }
};
