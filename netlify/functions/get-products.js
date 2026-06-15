const { Client, Environment } = require('square');

// 1. HARDCODED TO PRODUCTION: This completely bypasses the missing environment variable issue.
const client = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: Environment.Production, 
});

exports.handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        // 2. SAFER FETCH: Using searchCatalogObjects instead of listCatalog prevents Node.js SDK crashes
        // and allows us to pull the actual image URLs at the same time.
        const response = await client.catalogApi.searchCatalogObjects({
            objectTypes: ['ITEM'],
            includeRelatedObjects: true
        });
        
        const objects = response.result.objects || [];
        const related = response.result.relatedObjects || [];
        
        // 3. IMAGE MAPPING: This extracts the actual .png/.jpg URLs so your product images show up
        const imageMap = {};
        related.forEach(rel => {
            if (rel.type === 'IMAGE' && rel.imageData && rel.imageData.url) {
                imageMap[rel.id] = rel.imageData.url;
            }
        });
        
        const products = objects.map(obj => {
            const itemData = obj.itemData || {};
            const variations = itemData.variations || [];
            const variationData = variations.length > 0 ? variations[0].itemVariationData : {};
            const priceMoney = variationData.priceMoney || { amount: 0 };
            
            // Match the product to its image URL
            let imageUrl = null;
            if (itemData.imageIds && itemData.imageIds.length > 0) {
                imageUrl = imageMap[itemData.imageIds[0]];
            }
            
            return {
                id: obj.id,
                name: itemData.name || 'Unnamed Item',
                description: itemData.description || '',
                price: Number(priceMoney.amount),
                imageUrl: imageUrl,
                sku: variationData.sku || null
            };
        });

        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(products)
        };
    } catch (error) {
        console.error("Square API Error:", error.message);
        return { 
            statusCode: 500, 
            body: JSON.stringify({ error: 'Failed to fetch products', details: error.message }) 
        };
    }
};
