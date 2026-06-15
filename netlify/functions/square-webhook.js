const axios = require('axios');
const { Resend } = require('resend');
const { Client, Environment } = require('square');

const resend = new Resend(process.env.RESEND_API_KEY);
const squareClient = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: Environment.Production,
});

exports.handler = async (event) => {
    // Master Safety Net: If anything in this entire file breaks, it emails you.
    try {
        if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

        const payload = JSON.parse(event.body);

        // Listen for either updated or created, just to be absolutely certain we catch it
        if ((payload.type === 'payment.updated' || payload.type === 'payment.created') && payload.data.object.payment.status === 'COMPLETED') {
            const payment = payload.data.object.payment;
            const orderId = payment.order_id;

            if (!orderId) throw new Error("Payment was completed, but Square did not attach an order_id.");

            // Get full details from Square
            const orderResponse = await squareClient.ordersApi.retrieveOrder(orderId);
            const order = orderResponse.result.order;
            const lineItems = order.lineItems || [];

            // Map items for Printful (Using Square's variation ID)
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

            // ── PRINTFUL ATTEMPT ──
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
                // If Printful complains, catch exactly what they said and email Ronnie immediately
                const errorReason = printfulError.response?.data ? JSON.stringify(printfulError.response.data) : printfulError.message;
                
                await resend.emails.send({
                    from: 'System <orders@rlpdezines.com>',
                    to: ['rlp@rlpdezines.com'],
                    subject: '🚨 URGENT: Printful Rejected Order',
                    html: `<p>Square took the payment, but Printful rejected the order!</p><p><strong>Square Order ID:</strong> ${orderId}</p><p><strong>Printful's Exact Error:</strong> ${errorReason}</p>`
                });
            }

            // ── RECEIPT EMAIL ATTEMPT ──
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

            return { statusCode: 200, body: 'Workflow completed successfully.' };
        }

        return { statusCode: 200, body: 'Webhook ignored event type.' };

    } catch (fatalError) {
        // FATAL CRASH TRIGGER: If the webhook code breaks completely, email Ronnie.
        await resend.emails.send({
            from: 'System <orders@rlpdezines.com>',
            to: ['rlp@rlpdezines.com'],
            subject: '🚨 FATAL WEBHOOK CRASH',
            html: `<p>The webhook completely crashed during an order update.</p><p><strong>System Error:</strong> ${fatalError.message}</p>`
        });
        return { statusCode: 200, body: 'Workflow crashed but acknowledged.' }; 
    }
};
