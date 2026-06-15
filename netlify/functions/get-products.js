const { Client, Environment } = require('square');

exports.handler = async (event) => {
    try {
        // 1. Check if Netlify is actually loading your variables
        if (!process.env.SQUARE_ACCESS_TOKEN) {
            throw new Error("Netlify is not passing the SQUARE_ACCESS_TOKEN to this function.");
        }

        const client = new Client({
            accessToken: process.env.SQUARE_ACCESS_TOKEN,
            environment: Environment.Production, 
        });

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
            const variationData = variations.length > 0 ? variations[0].itemVariationData : {};
            const priceMoney = variationData.priceMoney || { amount: 0 };
            
            let imageUrl = null;
            if (itemData.imageIds && itemData.imageIds.length > 0) {
                imageUrl = imageMap[itemData.imageIds[0]];
            }
            
            // Safely convert Square's pricing format
            const safePrice = typeof priceMoney.amount === 'bigint' ? 
                              Number(priceMoney.amount) : 
                              Number(priceMoney.amount || 0);

            return {
                id: obj.id,
                name: itemData.name || 'Unnamed Item',
                description: itemData.description || '',
                price: safePrice,
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
        // DIAGNOSTIC MODE: Force a 200 success status so the website doesn't crash, 
        // but send the exact error text as a fake "product" so you can read it.
        let errorDetails = error.message;
        if (error.errors && error.errors.length > 0) {
            errorDetails = error.errors[0].detail || error.errors[0].code || error.message;
        }

        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify([{
                id: 'debug_error',
                name: '🚨 BACKEND ERROR 🚨',
                description: `DETAILS: ${errorDetails}`,
                price: 0,
                imageUrl: null
            }])
        };
    }
};
