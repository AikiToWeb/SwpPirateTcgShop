-- Run once; subsequent category edits belong to the database.
-- Preserve existing products/events; only correct the Flesh and Blood spelling.
UPDATE cards SET game='플래시 앤 블러드' WHERE game='플레시 앤 블러드';
UPDATE shop_events SET game='플래시 앤 블러드' WHERE game='플레시 앤 블러드';
DELETE FROM games WHERE name IN ('매직 더 개더링','로카나','플레시 앤 블러드');
INSERT INTO games(name,sort_order) SELECT '원피스 카드게임',0 WHERE NOT EXISTS(SELECT 1 FROM games WHERE name='원피스 카드게임');
UPDATE games SET sort_order=0 WHERE name='원피스 카드게임';
INSERT INTO games(name,sort_order) SELECT '플래시 앤 블러드',1 WHERE NOT EXISTS(SELECT 1 FROM games WHERE name='플래시 앤 블러드');
UPDATE games SET sort_order=1 WHERE name='플래시 앤 블러드';
INSERT INTO games(name,sort_order) SELECT '리프트바운드',2 WHERE NOT EXISTS(SELECT 1 FROM games WHERE name='리프트바운드');
UPDATE games SET sort_order=2 WHERE name='리프트바운드';
ALTER TABLE cards ALTER COLUMN game SET DEFAULT '';
