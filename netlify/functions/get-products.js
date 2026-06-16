const { Client, Environment } = require('square');

const client = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: Environment.Production, 
});

exports.handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        let objects = [];
        let related = [];
        let cursor = undefined;

        // Fetch all pages of the catalog
        do {
            const response = await client.catalogApi.searchCatalogObjects({
                objectTypes: ['ITEM'],
                includeRelatedObjects: true,
                cursor: cursor
            });
            
            if (response.result.objects) objects.push(...response.result.objects);
            if (response.result.relatedObjects) related.push(...response.result.relatedObjects);
            
            cursor = response.result.cursor;
        } while (cursor);
        
        const imageMap = {};
        const categoryMap = {};
        
        // Build reference dictionaries for Images and Categories
        related.forEach(rel => {
            if (rel.type === 'IMAGE' && rel.imageData && rel.imageData.url) {
                imageMap[rel.id] = rel.imageData.url;
            }
            if (rel.type === 'CATEGORY' && rel.categoryData && rel.categoryData.name) {
                categoryMap[rel.id] = rel.categoryData.name;
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
                    price: Number(priceMoney.amount || 0)
                };
            })
            // ── THE FIX: Filter out 0 price AND any variant containing "bundle" ──
            .filter(v => v.price > 0 && !v.name.toLowerCase().includes('bundle'));
            
            let categoryName = 'Other Goods';
            
            // Check both legacy and modern Square Category arrays
            if (itemData.categoryId && categoryMap[itemData.categoryId]) {
                categoryName = categoryMap[itemData.categoryId];
            } else if (itemData.categories && itemData.categories.length > 0) {
                const catId = itemData.categories[0].id;
                if (categoryMap[catId]) {
                    categoryName = categoryMap[catId];
                }
            }

            return {
                id: obj.id,
                name: itemData.name || 'Unnamed Item',
                description: itemData.description || '',
                imageUrl: (itemData.imageIds && itemData.imageIds.length > 0) ? imageMap[itemData.imageIds[0]] : null,
                category: categoryName,
                variations: mappedVariations
            };
        }).filter(p => p.variations.length > 0); // Completely hides the product if NO variants pass the filter

        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(products)
        };
    } catch (error) {
        console.error("Square API Fetch Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
