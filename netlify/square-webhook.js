// netlify/functions/square-webhook.js
const axios = require('axios');
const { Resend } = require('resend');
const crypto = require('crypto');

const resend = new Resend(process.env.RESEND_API_KEY);

// Helper to validate Square Webhook signature
function isValidSquareSignature(signature, body) {
    const hmac = crypto.createHmac('sha256', process.env.SQUARE_WEBHOOK_SIGNATURE_KEY);
    hmac.update(process.env.URL + '/.netlify/functions/square-webhook' + body);
    const hash = hmac.digest('base64');
    return hash === signature;
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const signature = event.headers['x-square-hmacsha256-signature'];
    if (!isValidSquareSignature(signature, event.body)) {
        return { statusCode: 401, body: 'Unauthorized webhook' };
    }

    const payload = JSON.parse(event.body);

    // Only process successful payments
    if (payload.type === 'payment.updated' && payload.data.object.payment.status === 'COMPLETED') {
        const payment = payload.data.object.payment;
        
        try {
            // 1. Create Printful Order
            // Note: In production, you'll need an intermediate step to fetch the full Square Order details 
            // via the payment.order_id to get exact items and shipping addresses for Printful.
            const printfulResponse = await axios.post('https://api.printful.com/orders', {
                recipient: {
                    name: payment.shipping_address.first_name + ' ' + payment.shipping_address.last_name,
                    address1: payment.shipping_address.address_line_1,
                    city: payment.shipping_address.locality,
                    state_code: payment.shipping_address.administrative_district_level_1,
                    country_code: payment.shipping_address.country,
                    zip: payment.shipping_address.postal_code
                },
                items: [
                    // You would map your Square Order Line Items here
                    // { sync_variant_id: "PRINTFUL_VARIANT_ID", quantity: 1 }
                ]
            }, {
                headers: { 'Authorization': `Bearer ${process.env.PRINTFUL_API_KEY}` }
            });

            // 2. Send Email Receipt via Resend
            await resend.emails.send({
                from: 'RLP Dezines <orders@rlpdezines.com>',
                to: [payment.buyer_email_address],
                subject: 'Thank you for your order — RLP Dezines',
                html: `<h1>Order Confirmed!</h1>
                       <p>Thank you for supporting Indigenous art. Your order is now in production.</p>
                       <p>Amount Paid: $${(payment.amount_money.amount / 100).toFixed(2)}</p>`
            });

            return { statusCode: 200, body: 'Success' };

        } catch (error) {
            console.error("Workflow Error:", error);
            return { statusCode: 500, body: 'Automation failed' };
        }
    }

    return { statusCode: 200, body: 'Ignored' };
};
