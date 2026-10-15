-- Run once; subsequent category edits belong to the database.
-- Preserve existing products/events; only correct the Flesh and Blood spelling.
UPDATE cards SET game='플래시 앤 블러드' WHERE game='플레시 앤 블러드';
UPDATE shop_events SET game='플래시 앤 블러드' WHERE game='플레시 앤 블러드';
DELETE FROM games WHERE name IN ('매직 더 개더링','로카나','플레시 앤 블러드');
MERGE INTO games(name,sort_order) KEY(name) VALUES('원피스 카드게임',0);
MERGE INTO games(name,sort_order) KEY(name) VALUES('플래시 앤 블러드',1);
MERGE INTO games(name,sort_order) KEY(name) VALUES('리프트바운드',2);
ALTER TABLE cards ALTER COLUMN game SET DEFAULT '';
