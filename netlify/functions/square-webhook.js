const axios = require('axios');
const { Resend } = require('resend');
const crypto = require('crypto');

const resend = new Resend(process.env.RESEND_API_KEY);

function isValidSquareSignature(signature, body) {
    const hmac = crypto.createHmac('sha256', process.env.SQUARE_WEBHOOK_SIGNATURE_KEY);
    hmac.update(process.env.URL + '/.netlify/functions/square-webhook' + body);
    const hash = hmac.digest('base64');
    return hash === signature;
}

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    // Comment out signature validation temporarily if you are testing manually
    const signature = event.headers['x-square-hmacsha256-signature'];
    if (!isValidSquareSignature(signature, event.body)) {
        return { statusCode: 401, body: 'Unauthorized webhook' };
    }

    const payload = JSON.parse(event.body);

    if (payload.type === 'payment.updated' && payload.data.object.payment.status === 'COMPLETED') {
        const payment = payload.data.object.payment;
        
        try {
            // 1. Push Order to Printful (Assuming SKUs are synced)
            if (payment.shipping_address) {
                await axios.post('https://api.printful.com/orders', {
                    recipient: {
                        name: payment.shipping_address.first_name + ' ' + payment.shipping_address.last_name,
                        address1: payment.shipping_address.address_line_1,
                        city: payment.shipping_address.locality,
                        state_code: payment.shipping_address.administrative_district_level_1,
                        country_code: payment.shipping_address.country,
                        zip: payment.shipping_address.postal_code
                    },
                    items: [] // You would populate this with Printful Sync Variant IDs based on the Square order
                }, {
                    headers: { 'Authorization': `Bearer ${process.env.PRINTFUL_API_KEY}` }
                });
            }

            // 2. Send Premium HTML Receipt via Resend
            const amountPaid = (payment.amount_money.amount / 100).toFixed(2);
            
            const htmlEmail = `
            <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #000000; color: #ffffff; padding: 40px; border-radius: 12px; border: 1px solid #1f1f1f;">
                <h1 style="color: #3b82f6; font-style: italic; font-weight: 900; letter-spacing: 2px; margin-bottom: 8px;">RLP DEZINES</h1>
                <p style="color: #9ca3af; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin-top: 0;">Indigenous Art & Apparel</p>
                
                <h2 style="font-size: 24px; margin-top: 40px; margin-bottom: 20px; text-transform: uppercase;">Order Confirmed</h2>
                <p style="color: #d1d5db; line-height: 1.6; font-size: 15px;">Thank you for your support. Your payment was successful, and your order is now being prepared for production.</p>
                
                <div style="background-color: #111111; border: 1px solid #333333; padding: 24px; border-radius: 8px; margin: 35px 0;">
                    <p style="margin: 0; color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; font-weight: bold;">Total Amount Paid</p>
                    <p style="margin: 8px 0 0; font-size: 32px; font-weight: 900; color: #ffffff;">$${amountPaid}</p>
                </div>
                
                <p style="color: #9ca3af; font-size: 14px; line-height: 1.6;">You will receive another email directly from our fulfillment center with tracking information the moment your items ship.</p>
                
                <hr style="border: 0; border-top: 1px solid #1f1f1f; margin: 40px 0;" />
                <p style="color: #4b5563; font-size: 11px; text-align: center; text-transform: uppercase; letter-spacing: 1px;">© ${new Date().getFullYear()} RLP Dezines. All rights reserved.</p>
            </div>
            `;

            await resend.emails.send({
                from: 'RLP Dezines <orders@rlpdezines.com>',
                to: [payment.buyer_email_address],
                subject: 'Receipt for your RLP Dezines Order',
                html: htmlEmail
            });

            return { statusCode: 200, body: 'Success' };

        } catch (error) {
            console.error("Workflow Error:", error);
            return { statusCode: 500, body: 'Automation failed' };
        }
    }

    return { statusCode: 200, body: 'Ignored' };
};
