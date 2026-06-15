const axios = require('axios');
const { Resend } = require('resend');
const { Client, Environment } = require('square');

const resend = new Resend(process.env.RESEND_API_KEY);
const squareClient = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: Environment.Production,
});

exports.handler = async (event) => {
    try {
        if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

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

            if (!recipient.city || !recipient.state_code) {
                throw new Error(`Address mapping failed. City: "${recipient.city}", State: "${recipient.state_code}"`);
            }

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
                
                // SILENCE THE DUPLICATE ALARM: If Printful says it already exists (OR-13), ignore it.
                if (errorReason.includes("already exists") || errorData.error?.message?.includes("already exists") || errorData.api_error_code === "OR-13") {
                    console.log(`Duplicate event for Square Order ${orderId} ignored safely. Order is live in Printful.`);
                } else {
                    // Send an actual, real production error alert
                    await resend.emails.send({
                        from: 'System <orders@rlpdezines.com>',
                        to: ['rlp@rlpdezines.com'],
                        subject: '🚨 URGENT: Printful Fulfillment Error',
                        html: `<p>Square took the payment, but the automated Printful pipeline hit a roadblock.</p><p><strong>Square Order ID:</strong> ${orderId}</p><p><strong>Printful Error Details:</strong> ${errorReason}</p>`
                    });
                }
            }

            // ── PREMIUM CUSTOMER CONFIRMATION EMAIL GENERATOR ──
            // Only send the premium customer receipt if this is the first webhook clearing it
            if (firstHookProcessed || !event.headers['x-square-retry-count'] || event.headers['x-square-retry-count'] === '0') {
                try {
                    const itemsHtml = lineItems.map(item => {
                        const totalLinePrice = item.totalMoney ? (item.totalMoney.amount / 100).toFixed(2) : "0.00";
                        return `
                            <tr>
                                <td style="padding: 12px 0; border-bottom: 1px solid #1f1f1f; color: #ffffff; font-size: 14px;">
                                    <strong style="color: #ffffff;">${item.name}</strong>
                                    <div style="color: #9ca3af; font-size: 12px; margin-top: 4px;">Qty: ${item.quantity}</div>
                                </td>
                                <td style="padding: 12px 0; border-bottom: 1px solid #1f1f1f; color: #ffffff; font-size: 14px; text-align: right; vertical-align: top;">
                                    $${totalLinePrice}
                                </td>
                            </tr>
                        `;
                    }).join('');

                    const totalTax = order.totalTaxMoney ? (order.totalTaxMoney.amount / 100).toFixed(2) : "0.00";
                    const totalGross = order.totalMoney ? (order.totalMoney.amount / 100).toFixed(2) : "0.00";
                    
                    const totalServiceCharges = order.totalServiceChargeMoney ? order.totalServiceChargeMoney.amount : 0;
                    const rawSubtotalCents = (order.totalMoney?.amount || 0) - (order.totalTaxMoney?.amount || 0) - totalServiceCharges;
                    const calculatedSubtotal = (rawSubtotalCents / 100).toFixed(2);
                    const calculatedShipping = (totalServiceCharges / 100).toFixed(2);

                    const emailHtml = `
                        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #000000; padding: 40px; border: 1px solid #111111; border-radius: 16px;">
                            <div style="text-align: center; margin-bottom: 40px; border-bottom: 1px solid #1f1f1f; padding-bottom: 30px;">
                                <h1 style="font-size: 28px; font-weight: 900; letter-spacing: 4px; color: #ffffff; font-style: italic; margin: 0; text-transform: uppercase;">RLP DEZINES</h1>
                                <p style="color: #3b82f6; font-size: 12px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; margin-top: 10px; margin-bottom: 0;">Order Confirmed & Sent To Production</p>
                            </div>
                            <p style="color: #d1d5db; font-size: 15px; line-height: 1.6; margin-bottom: 30px;">
                                Miigwech (Thank you) for supporting authentic design. Your payment cleared successfully, and your custom gear has officially entered production. Here is your transaction breakdown:
                            </p>
                            <table style="width: 100%; border-collapse: collapse; margin-bottom: 30px;">
                                <thead>
                                    <tr>
                                        <th style="text-align: left; color: #9ca3af; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; padding-bottom: 10px; border-bottom: 1px solid #333333;">Item Description</th>
                                        <th style="text-align: right; color: #9ca3af; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; padding-bottom: 10px; border-bottom: 1px solid #333333;">Total</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${itemsHtml}
                                </tbody>
                            </table>
                            <div style="background-color: #0a0a0a; border: 1px solid #1f1f1f; padding: 24px; border-radius: 12px; margin-bottom: 35px;">
                                <table style="width: 100%; border-collapse: collapse;">
                                    <tr>
                                        <td style="color: #9ca3af; font-size: 14px; padding-bottom: 10px;">Subtotal</td>
                                        <td style="color: #ffffff; font-size: 14px; text-align: right; padding-bottom: 10px;">$${calculatedSubtotal}</td>
                                    </tr>
                                    <tr>
                                        <td style="color: #9ca3af; font-size: 14px; padding-bottom: 10px;">Standard Shipping</td>
                                        <td style="color: #ffffff; font-size: 14px; text-align: right; padding-bottom: 10px;">$${calculatedShipping}</td>
                                    </tr>
                                    <tr>
                                        <td style="color: #9ca3af; font-size: 14px; padding-bottom: 15px; border-bottom: 1px solid #1f1f1f;">Estimated Tax</td>
                                        <td style="color: #ffffff; font-size: 14px; text-align: right; padding-bottom: 15px; border-bottom: 1px solid #1f1f1f;">$${totalTax}</td>
                                    </tr>
                                    <tr>
                                        <td style="color: #ffffff; font-size: 16px; font-weight: bold; padding-top: 15px;">Total Charged</td>
                                        <td style="color: #3b82f6; font-size: 20px; font-weight: bold; text-align: right; padding-top: 15px;">$${totalGross}</td>
                                    </tr>
                                </table>
                            </div>
                            <div style="border-top: 1px solid #1f1f1f; padding-top: 30px; margin-bottom: 10px;">
                                <h3 style="color: #ffffff; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px;">Delivery Destination:</h3>
                                <p style="color: #9ca3af; font-size: 14px; line-height: 1.5; margin: 0; background-color: #0a0a0a; padding: 16px; border-radius: 8px; border: 1px solid #1f1f1f;">
                                    <strong style="color: #ffffff;">${recipient.name}</strong><br>
                                    ${recipient.address1}<br>
                                    ${recipient.city}, ${recipient.state_code} ${recipient.zip}
                                </p>
                            </div>
                            <div style="margin-top: 40px; border-top: 1px solid #1f1f1f; padding-top: 20px; text-align: center;">
                                <p style="color: #6b7280; font-size: 12px; line-height: 1.6; margin: 0 0 15px 0;">
                                    Because our drops are custom-produced specifically for you, entries cannot be adjusted once in production. If you notice an immediate defect upon arrival, contact us within 14 days.
                                </p>
                                <p style="color: #4b5563; font-size: 11px; margin: 0;">
                                    Square Order Reference: ${orderId}
                                </p>
                            </div>
                        </div>
                    `;

                    await resend.emails.send({
                        from: 'RLP Dezines <orders@rlpdezines.com>',
                        to: [recipient.email],
                        subject: 'Receipt from RLP Dezines',
                        html: emailHtml
                    });
                    console.log("Premium itemized receipt deployed successfully.");
                } catch (emailError) {
                    console.error("Resend API Error:", emailError.message);
                }
            }

            return { statusCode: 200, body: 'Workflow completed successfully.' };
        }

        return { statusCode: 200, body: 'Webhook ignored event type.' };

    } catch (fatalError) {
        await resend.emails.send({
            from: 'System <orders@rlpdezines.com>',
            to: ['rlp@rlpdezines.com'],
            subject: '🚨 FATAL WEBHOOK CRASH',
            html: `<p>The webhook completely crashed during an order update.</p><p><strong>System Error:</strong> ${fatalError.message}</p>`
        });
        return { statusCode: 200, body: 'Workflow crashed but acknowledged.' }; 
    }
};
