exports.handler = async (event) => {
    // Netlify secretly grabs your Square token here
    const token = process.env.SQUARE_ACCESS_TOKEN;
    if (!token) return { statusCode: 500, body: JSON.stringify({ success: false, message: "Missing Square Access Token." }) };

    const action = event.queryStringParameters.action;

    // 1. SECURELY LOAD CATALOG
    if (action === 'catalog') {
        try {
            const res = await fetch('https://connect.squareup.com/v2/catalog/list?types=ITEM,IMAGE', {
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
            });
            const data = await res.json();
            if (!data.objects) return { statusCode: 200, body: JSON.stringify({ products: [] }) };

            const items = data.objects.filter(obj => obj.type === 'ITEM');
            const images = data.objects.filter(obj => obj.type === 'IMAGE');

            const catalog = items.map(item => {
                const itemData = item.item_data;
                const variation = itemData.variations[0].item_variation_data;
                const price = variation.price_money ? variation.price_money.amount : 0;
                const imageId = itemData.image_ids ? itemData.image_ids[0] : null;
                const imageObj = images.find(img => img.id === imageId);
                const imageUrl = imageObj ? imageObj.image_data.url : 'https://via.placeholder.com/400';

                return {
                    id: item.id,
                    name: itemData.name,
                    price: price,
                    tag: "Live Drop",
                    tagColor: "orange",
                    desc: itemData.description || "Premium RLP Dezines gear.",
                    img: imageUrl
                };
            });

            return { statusCode: 200, body: JSON.stringify({ products: catalog }) };
        } catch (error) { return { statusCode: 500, body: JSON.stringify({ error: error.message }) }; }
    }

    // 2. SECURELY PROCESS PAYMENT
    if (action === 'pay') {
        try {
            const body = JSON.parse(event.body);
            const amount = body.cart.reduce((total, item) => total + (item.price * item.qty), 0);
            const idempotency_key = Date.now().toString() + Math.random().toString(); // Prevents double charges

            const payRes = await fetch('https://connect.squareup.com/v2/payments', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    source_id: body.sourceId,
                    idempotency_key: idempotency_key,
                    amount_money: { amount: amount, currency: 'USD' },
                    location_id: 'L5CPNKT6Y7JE7' // Your Production Location ID is locked in here
                })
            });
            const payData = await payRes.json();

            if (payData.errors) return { statusCode: 400, body: JSON.stringify({ success: false, message: payData.errors[0].detail }) };
            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        } catch (error) { return { statusCode: 500, body: JSON.stringify({ success: false, message: error.message }) }; }
    }

    return { statusCode: 400, body: "Action not found." };
};
