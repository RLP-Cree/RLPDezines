const axios = require('axios');
const { Resend } = require('resend');
const { Client, Environment } = require('square');

const resend = new Resend(process.env.RESEND_API_KEY);

const squareClient = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: Environment.Production,
});

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        const payload = JSON.parse(event.body);

        // Listen explicitly for completed payments
        if (payload.type === 'payment.updated' && payload.data.object.payment.status === 'COMPLETED') {
            const payment = payload.data.object.payment;
            const orderId = payment.order_id;

            if (!orderId) {
                console.error("No Order ID associated with this payment.");
                return { statusCode: 400, body: 'Missing order_id' };
            }

            // 1. Fetch the complete order details from Square to grab the item SKUs
            const orderResponse = await squareClient.ordersApi.retrieveOrder(orderId);
            const order = orderResponse.result.order;
            const lineItems = order.lineItems || [];

            // 2. Format the items array specifically for Printful's API layout
            const printfulItems = lineItems.map(item => {
                // If a product is customized or doesn't use standard SKUs, fallback gracefully
                return {
                    sync_variant_id: item.catalogObjectId, // Bypasses empty SKUs by using Square ID
                    external_variant_id: item.sku || item.catalogObjectId,
                    name: item.name,
                    quantity: parseInt(item.quantity) || 1,
                    price: (Number(item.basePriceMoney?.amount || 0) / 100).toFixed(2)
                };
            });

            // 3. Construct the shipping recipient information using Square's data
            const recipient = {
                name: payment.shipping_address?.first_name 
                    ? `${payment.shipping_address.first_name} ${payment.shipping_address.last_name}`
                    : 'Ronald Lodgepole',
                address1: payment.shipping_address?.address_line_1 || 'Address on file',
                city: payment.shipping_address?.locality || '',
                state_code: payment.shipping_address?.administrative_district_level_1 || '',
                country_code: payment.shipping_address?.country || 'US',
                zip: payment.shipping_address?.postal_code || '',
                email: payment.buyer_email_address || 'rlp@rlpdezines.com',
                phone: payment.shipping_address?.phone_number || ''
            };

            // 4. Send the structured payload directly to Printful to create a pending order
            const printfulPayload = {
                external_id: orderId,
                shipping: "STANDARD",
                recipient: recipient,
                items: printfulItems,
                retail_costs: {
                    subtotal: (Number(order.netAmounts?.subtotalMoney?.amount || 0) / 100).toFixed(2),
                    tax: (Number(order.netAmounts?.taxMoney?.amount || 0) / 100).toFixed(2),
                    shipping: (Number(order.netAmounts?.serviceChargeMoney?.amount || 0) / 100).toFixed(2),
                    total: (Number(order.netAmounts?.totalMoney?.amount || 0) / 100).toFixed(2)
                }
            };

            const printfulRes = await axios.post('https://api.printful.com/orders', printfulPayload, {
                headers: { 
                    'Authorization': `Bearer ${process.env.PRINTFUL_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            });

            console.log("Printful Order Successfully Drafted:", printfulRes.data.result.id);

            // 5. Send the premium themed HTML receipt to your customer via Resend
            const totalPaid = (payment.amount_money.amount / 100).toFixed(2);
            const emailHtml = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background-color: #000; color: #fff; padding: 40px; border-radius: 12px; border: 1px solid #1f1f1f;">
                    <h1 style="font-size: 24px; font-weight: 900; letter-spacing: 2px; font-style: italic; margin-bottom: 30px; color:#fff;">RLP DEZINES</h1>
                    <h2 style="font-size: 20px; font-weight: bold; color: #3B82F6; text-transform: uppercase; letter-spacing: 1px; border-bottom: 1px solid #333; padding-bottom: 15px;">Order Confirmed</h2>
                    <p style="color: #d1d5db; line-height: 1.6; font-size: 15px;">Your order has been successfully processed and is now entering production.</p>
                    <div style="background-color: #111; padding: 20px; border-radius: 8px; margin: 30px 0; border: 1px solid #222;">
                        <p style="margin: 0 0 10px 0; color: #9ca3af; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Amount Paid</p>
                        <p style="margin: 0; font-size: 28px; font-weight: bold; color: #fff;">$${totalPaid}</p>
                    </div>
                    <h3 style="font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #9ca3af; margin-top: 30px;">Shipping To:</h3>
                    <p style="color: #fff; font-size: 14px; line-height: 1.5;">
                        ${recipient.name}<br>
                        ${recipient.address1}<br>
                        ${recipient.city}, ${recipient.state_code} ${recipient.zip}
                    </p>
                    <p style="color: #d1d5db; line-height: 1.6; font-size: 13px; margin-top: 40px; border-top: 1px solid #333; padding-top: 20px;">
                        Once our fulfillment team packages your order, a tracking link will be automatically generated and emailed directly to your inbox.
                    </p>
                </div>
            `;

            await resend.emails.send({
                from: 'RLP Dezines <orders@rlpdezines.com>',
                to: [recipient.email],
                subject: 'Receipt from RLP Dezines',
                html: emailHtml
            });

            return { statusCode: 200, body: 'Order and email processed successfully.' };
        }

        return { statusCode: 200, body: 'Webhook ignored event type.' };

    } catch (error) {
        console.error("Webhook Execution Failure:", error.response ? error.response.data : error.message);
        return { 
            statusCode: 500, 
            body: JSON.stringify({ error: 'Fulfillment automation pipeline halted.', log: error.message }) 
        };
    }
};
