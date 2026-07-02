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
            
            // ── NEW FIX: THE STATUTE OF LIMITATIONS ──
            // Calculate how old the order is. If it's older than 2 hours, it's a historical sync ghost. Ignore it!
            const orderCreatedAt = new Date(order.createdAt).getTime();
            const now = Date.now();
            const hoursSinceCreation = (now - orderCreatedAt) / (1000 * 60 * 60);

            if (hoursSinceCreation > 2) {
                console.log(`⚠️ GHOST ORDER BLOCKED: Order ${orderId} is ${hoursSinceCreation.toFixed(2)} hours old. Ignoring to prevent duplicate fulfillment.`);
                return { statusCode: 200, body: 'Historical order safely ignored.' };
            }
            // ─────────────────────────────────────────

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
                    isFreshOrder = true; // It IS a new order, Printful just errored out. Email the customer their receipt!
                    
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

            // ── PREMIUM LUXURY CONFIRMATION EMAIL (STONE THEME) ──
            if (isFreshOrder) {
                try {
                    // Generate Stone-themed item rows
                    const itemsHtml = lineItems.map(item => {
                        const totalLinePrice = item.totalMoney ? (Number(item.totalMoney.amount) / 100).toFixed(2) : "0.00";
                        return `
                            <tr>
                                <td style="padding: 16px 0; border-bottom: 1px solid #e7e5e4; text-align: left;">
                                    <strong style="color: #1c1917; font-size: 14px; font-weight: 700;">${item.name}</strong>
                                    <div style="color: #78716c; font-size: 13px; margin-top: 4px;">Qty: ${item.quantity}</div>
                                </td>
                                <td style="padding: 16px 0; border-bottom: 1px solid #e7e5e4; color: #1c1917; text-align: right; font-weight: 600; font-size: 14px;">$${totalLinePrice}</td>
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
                            <!DOCTYPE html>
                            <html>
                            <head>
                                <meta charset="UTF-8">
                                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                                <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700;900&display=swap" rel="stylesheet">
                            </head>
                            <body style="margin: 0; padding: 0; background-color: #fafaf9; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
                                
                                <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color: #fafaf9; padding: 40px 20px;">
                                    <tr>
                                        <td align="center">
                                            <!-- Main Card -->
                                            <table width="100%" max-width="600" cellpadding="0" cellspacing="0" role="presentation" style="max-width: 600px; background-color: #ffffff; border: 1px solid #e7e5e4; border-radius: 24px; padding: 50px 40px; text-align: center; margin: 0 auto; box-shadow: 0 10px 25px rgba(0,0,0,0.03);">
                                                <tr>
                                                    <td align="center">
                                                        <h1 style="font-size: 28px; font-weight: 900; letter-spacing: 4px; font-style: italic; text-transform: uppercase; color: #1c1917; margin: 0 0 16px 0;">RLP DEZINES</h1>
                                                        
                                                        <!-- Status Badge -->
                                                        <div style="display: inline-block; background-color: #f5f5f4; color: #1c1917; padding: 8px 20px; border-radius: 9999px; font-size: 11px; font-weight: 800; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 35px;">
                                                            Order Confirmed
                                                        </div>
                                                        
                                                        <!-- Message -->
                                                        <p style="color: #78716c; font-size: 16px; line-height: 1.7; font-weight: 300; margin: 0 0 20px 0;">
                                                            Ahoooo!! for supporting authentic design. Your payment has cleared successfully, and your custom gear has officially entered production.
                                                        </p>
                                                        
                                                        <p style="color: #78716c; font-size: 16px; line-height: 1.7; font-weight: 300; margin: 0 0 10px 0;">
                                                            A detailed, itemized receipt is below. Because our drops are custom-produced specifically for you, the factory floor has already started spinning up your order.
                                                        </p>
                                                        <p style="color: #a8a29e; font-size: 12px; font-style: italic; margin: 0 0 40px 0;">
                                                            (Please refer to your receipt for our custom-order return policies.)
                                                        </p>

                                                        <!-- ITEM RECEIPT SECTION -->
                                                        <div style="text-align: left; margin: 35px 0; border-top: 1px solid #e7e5e4; padding-top: 25px;">
                                                            <table style="width: 100%; border-collapse: collapse; margin-bottom: 5px;">
                                                                <tbody>
                                                                    ${itemsHtml}
                                                                </tbody>
                                                            </table>
                                                            
                                                            <table style="width: 100%; border-collapse: collapse; margin-top: 15px;">
                                                                <tr>
                                                                    <td style="padding: 6px 0; color: #78716c; font-size: 14px; text-align: left;">Subtotal:</td>
                                                                    <td style="padding: 6px 0; color: #1c1917; font-size: 14px; text-align: right; font-weight: 600;">$${calculatedSubtotal.toFixed(2)}</td>
                                                                </tr>
                                                                <tr>
                                                                    <td style="padding: 6px 0; color: #78716c; font-size: 14px; text-align: left;">Shipping:</td>
                                                                    <td style="padding: 6px 0; color: #1c1917; font-size: 14px; text-align: right; font-weight: 600;">$${calculatedShipping}</td>
                                                                </tr>
                                                                <tr>
                                                                    <td style="padding: 6px 0; color: #78716c; font-size: 14px; text-align: left;">Tax:</td>
                                                                    <td style="padding: 6px 0; color: #1c1917; font-size: 14px; text-align: right; font-weight: 600;">$${totalTax}</td>
                                                                </tr>
                                                                <tr>
                                                                    <td style="padding: 16px 0 0 0; color: #1c1917; font-size: 15px; font-weight: 800; text-align: left; text-transform: uppercase;">Total:</td>
                                                                    <td style="padding: 16px 0 0 0; color: #1c1917; font-size: 20px; font-weight: 900; text-align: right;">$${totalGross}</td>
                                                                </tr>
                                                            </table>

                                                            <div style="margin-top: 30px; padding: 20px; background-color: #fafaf9; border-radius: 12px; border: 1px solid #e7e5e4;">
                                                                <p style="margin: 0 0 10px 0; font-weight: 800; color: #1c1917; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Shipping To:</p>
                                                                <p style="margin: 0 0 4px 0; color: #78716c; font-size: 14px;">${recipient.name}</p>
                                                                <p style="margin: 0 0 4px 0; color: #78716c; font-size: 14px;">${recipient.address1}</p>
                                                                <p style="margin: 0 0 4px 0; color: #78716c; font-size: 14px;">${recipient.city}, ${recipient.state_code} ${recipient.zip}</p>
                                                                <p style="margin: 0; color: #78716c; font-size: 14px;">${recipient.country_code}</p>
                                                            </div>
                                                        </div>

                                                        <!-- Community Call-Out -->
                                                        <div style="background-color: #fafaf9; border: 1px solid #e7e5e4; padding: 24px; border-radius: 16px; margin-bottom: 40px; text-align: left;">
                                                            <h4 style="font-weight: 800; font-size: 12px; color: #1c1917; text-transform: uppercase; letter-spacing: 1.5px; margin: 0 0 10px 0;">Rep Your Culture</h4>
                                                            <p style="font-size: 14px; color: #78716c; line-height: 1.6; font-weight: 300; margin: 0;">
                                                                When your package lands, tag us on Facebook or Instagram <strong style="color: #1c1917; font-weight: 700;">@rlp_cree</strong> so we can share it with the community!
                                                            </p>
                                                        </div>

                                                        <!-- Luxury Pill Button -->
                                                        <a href="https://rlpdezines.com" style="display: inline-block; background-color: #1c1917; color: #ffffff; text-decoration: none; padding: 18px 32px; border-radius: 9999px; font-weight: 900; font-size: 13px; letter-spacing: 1.5px; text-transform: uppercase; text-align: center; width: 100%; box-sizing: border-box;">
                                                            Return to Shop
                                                        </a>

                                                    </td>
                                                </tr>
                                            </table>
                                            
                                            <!-- Footer -->
                                            <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-top: 20px; text-align: center;">
                                                <tr>
                                                    <td align="center" style="color: #a8a29e; font-size: 11px; line-height: 1.5;">
                                                        © 2026 RLP Dezines. Indigenous-owned & operated.<br>
                                                        Town of Gilbert Bus. License: BUSLIC001339-05-2024
                                                    </td>
                                                </tr>
                                            </table>

                                        </td>
                                    </tr>
                                </table>
                            </body>
                            </html>
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
