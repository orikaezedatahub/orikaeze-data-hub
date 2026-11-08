-- Use the repository's raw asset host for the ORIKAEZE HUB wig photo.
-- GitHub Pages image delivery was failing on the live marketplace card.
UPDATE marketplace_products
SET image_url = 'https://raw.githubusercontent.com/orikaezedatahub/orikaeze-data-hub/main/assets/products/orikaeze-hub-wig.jpg'
WHERE id = 'orikaeze_hub_wig_pixie_14';
