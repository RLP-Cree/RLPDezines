const { Client, Environment } = require('square');

const client = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: process.env.SQUARE_ENVIRONMENT === 'production' ? Environment.Production : Environment.Sandbox,
});

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        const response = await client.catalogApi.listCatalog(null, 'ITEM');
        
        // 1. Safe fallback: If the catalog is completely empty, return an empty array instead of crashing
        const objects = response.result.objects || [];
        
        // 2. Safe mapping: Check that pricing and variations actually exist before reading them
        const products = objects.map(obj => {
            const itemData = obj.itemData || {};
            const variations = itemData.variations || [];
            const variationData = variations.length > 0 ? variations[0].itemVariationData : {};
            const priceMoney = variationData.priceMoney || { amount: 0 };
            
            return {
                id: obj.id,
                name: itemData.name || 'Unnamed Item',
                description: itemData.description || '',
                price: Number(priceMoney.amount),
                imageUrl: itemData.imageIds ? itemData.imageIds[0] : null,
                sku: variationData.sku || null
            };
        });

        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(products)
        };
    } catch (error) {
        // This will print the exact reason to your Netlify Function Logs if it fails again
        console.error("Square API Error:", error.message);
        if(error.errors) console.error("Square Error Details:", JSON.stringify(error.errors));
        
        return { 
            statusCode: 500, 
            body: JSON.stringify({ error: 'Failed to fetch products', details: error.message }) 
        };
    }
};
