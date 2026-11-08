-- Attach the published ORIKAEZE HUB wig photo to the existing owner-stock listing.
UPDATE marketplace_products
SET image_url = 'https://orikaezedatahub.github.io/orikaeze-data-hub/assets/products/orikaeze-hub-wig.jpg'
WHERE id = 'orikaeze_hub_wig_pixie_14';
