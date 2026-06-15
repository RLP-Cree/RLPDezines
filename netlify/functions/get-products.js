const { Client, Environment } = require('square');

const client = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: Environment.Production, 
});

exports.handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        const response = await client.catalogApi.searchCatalogObjects({
            objectTypes: ['ITEM'],
            includeRelatedObjects: true
        });
        
        const objects = response.result.objects || [];
        const related = response.result.relatedObjects || [];
        
        const imageMap = {};
        related.forEach(rel => {
            if (rel.type === 'IMAGE' && rel.imageData && rel.imageData.url) {
                imageMap[rel.id] = rel.imageData.url;
            }
        });
        
        const products = objects.map(obj => {
            const itemData = obj.itemData || {};
            const variations = itemData.variations || [];
            
            // Map every single size/color option for this item
            const mappedVariations = variations.map(v => {
                const vData = v.itemVariationData || {};
                const priceMoney = vData.priceMoney || { amount: 0 };
                const safePrice = typeof priceMoney.amount === 'bigint' ? Number(priceMoney.amount) : Number(priceMoney.amount || 0);

                return {
                    id: v.id, // Square's unique ID for this specific size/color
                    name: vData.name || 'Regular', // e.g., "Large, Black"
                    sku: vData.sku || '', // CRITICAL: This routes it to Printful
                    price: safePrice
                };
            }).filter(v => v.price > 0); // Only keep valid ones
            
            let imageUrl = null;
            if (itemData.imageIds && itemData.imageIds.length > 0) {
                imageUrl = imageMap[itemData.imageIds[0]];
            }

            return {
                id: obj.id,
                name: itemData.name || 'Unnamed Item',
                description: itemData.description || '',
                imageUrl: imageUrl,
                variations: mappedVariations // We now send the whole list to the website
            };
        }).filter(p => p.variations.length > 0); // Don't show items with no valid variations

        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(products)
        };

    } catch (error) {
        console.error("Square API Error:", error.message);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to fetch products' }) };
    }
};
