-- Tali — 0015: retire the list_items scaffold columns (ticket #119)
--
-- `list_items` was born the Slice 1 scaffold table (`title` / `checked` /
-- `sort_order`) and extended in place by 0005 with the real ListItem columns
-- (`name` / `done` / `ordering`), which 0005 also backfilled from the scaffold
-- ones. Every writer has dual-written both sets since #34 so the sync wire
-- could keep speaking the scaffold names.
--
-- #119 retires the scaffold wire shape: the sync registry, the planning repo
-- and the web mirror all speak the aggregate's own fields, and no writer
-- touches the scaffold columns. `title` is NOT NULL without a default, so the
-- columns must go for an insert that omits them to be valid at all.
--
-- No backfill is performed: 0005 already copied these values into the real
-- columns, and this is a stage environment (ADR-0011's precedent) — existing
-- rows do not matter.

ALTER TABLE list_items DROP COLUMN title;
ALTER TABLE list_items DROP COLUMN checked;
ALTER TABLE list_items DROP COLUMN sort_order;
