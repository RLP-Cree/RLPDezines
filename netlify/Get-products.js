// netlify/functions/get-products.js
const { Client, Environment } = require('square');

const client = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: process.env.SQUARE_ENVIRONMENT === 'production' ? Environment.Production : Environment.Sandbox,
});

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        const response = await client.catalogApi.listCatalog(null, 'ITEM');
        
        // Map Square items to a clean JSON array for your frontend
        const products = response.result.objects.map(obj => {
            const itemData = obj.itemData;
            const variation = itemData.variations[0].itemVariationData;
            return {
                id: obj.id,
                name: itemData.name,
                description: itemData.description,
                price: Number(variation.priceMoney.amount), // Price in cents
                imageUrl: itemData.imageIds ? itemData.imageIds[0] : null,
                sku: variation.sku // Important: Map this to your Printful Sync Variant ID
            };
        });

        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(products)
        };
    } catch (error) {
        console.error("Square Catalog Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch products' }) };
    }
};
