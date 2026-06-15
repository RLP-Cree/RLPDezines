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

            // Fetch full order data directly from the Square SDK
            const orderResponse = await squareClient.ordersApi.retrieveOrder(orderId);
            const order = orderResponse.result.order;
            const lineItems = order.lineItems || [];

            // Map products for Printful using the catalog IDs
            const printfulItems = lineItems.map(item => ({
                external_variant_id: item.sku || item.catalogObjectId,
                quantity: parseInt(item.quantity) || 1,
                name: item.name
            }));

            // ── THE DETAILED ADDRESS FIX ──
            // Square's SDK converts backend data to camelCase. 
            // We drill straight into the fulfillment layer where the checkout address lives.
            const fulfillment = order.fulfillments?.[0] || {};
            const shipmentDetails = fulfillment.shipmentDetails || {};
            const orderRecipient = shipmentDetails.recipient || {};
            const orderAddress = orderRecipient.address || {};

            // Backup layer: check the raw payment snake_case fields if fulfillment is missing
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

            // Double check that we aren't bypassing required metrics
            if (!recipient.city || !recipient.state_code) {
                throw new Error(`Address mapping failed. City: "${recipient.city}", State: "${recipient.state_code}"`);
            }

            // ── SUBMIT TO PRINTFUL ──
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
                const errorReason = printfulError.response?.data ? JSON.stringify(printfulError.response.data) : printfulError.message;
                
                await resend.emails.send({
                    from: 'System <orders@rlpdezines.com>',
                    to: ['rlp@rlpdezines.com'],
                    subject: '🚨 URGENT: Printful Rejected Order',
                    html: `<p>Square took the payment, but Printful rejected the order!</p><p><strong>Square Order ID:</strong> ${orderId}</p><p><strong>Printful's Exact Error:</strong> ${errorReason}</p>`
                });
            }

            // ── CUSTOMER CONFIRMATION EMAIL ──
            try {
                const totalPaid = (payment.amount_money.amount / 100).toFixed(2);
                const emailHtml = `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #000; color: #fff; padding: 40px; border-radius: 12px; border: 1px solid #1f1f1f;">
                        <h1 style="font-size: 24px; font-weight: 900; letter-spacing: 2px; font-style: italic; margin-bottom: 30px; color:#fff;">RLP DEZINES</h1>
                        <h2 style="font-size: 20px; font-weight: bold; color: #3B82F6; text-transform: uppercase; border-bottom: 1px solid #333; padding-bottom: 15px;">Order Confirmed</h2>
                        <p style="color: #d1d5db;">Your order has been successfully processed and sent to production.</p>
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
