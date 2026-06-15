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
            
            const mappedVariations = variations.map(v => {
                const vData = v.itemVariationData || {};
                const priceMoney = vData.priceMoney || { amount: 0 };
                return {
                    id: v.id,
                    name: vData.name || 'Regular',
                    sku: vData.sku || '',
                    price: Number(priceMoney.amount)
                };
            }).filter(v => v.price > 0);
            
            // FIX: Pulling Reporting Category directly from itemData
            const categoryName = itemData.reportingCategory?.name || 'Other Goods';

            return {
                id: obj.id,
                name: itemData.name || 'Unnamed Item',
                description: itemData.description || '',
                imageUrl: (itemData.imageIds && itemData.imageIds.length > 0) ? imageMap[itemData.imageIds[0]] : null,
                category: categoryName,
                variations: mappedVariations
            };
        }).filter(p => p.variations.length > 0);

        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(products)
        };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
