-- Up Migration
-- panel_databases'e motor kolonu.
--
-- Tablo Modul 2 hazirliginda acilmisti ama yalnizca PostgreSQL varsayiyordu:
-- db_name/db_user global UNIQUE idi. Iki motor birden desteklenince ayni ad
-- hem PostgreSQL hem MySQL tarafinda bulunabilir (bunlar ayri sunucular),
-- bu yuzden benzersizlik (engine, ad) ciftine tasiniyor.

ALTER TABLE panel_databases
    ADD COLUMN engine VARCHAR(16) NOT NULL DEFAULT 'postgres';

-- Motor degeri uygulama katminda da dogrulanir; burasi son savunma hatti.
ALTER TABLE panel_databases
    ADD CONSTRAINT panel_databases_engine_check
    CHECK (engine IN ('postgres', 'mysql'));

ALTER TABLE panel_databases DROP CONSTRAINT IF EXISTS panel_databases_db_name_key;
ALTER TABLE panel_databases DROP CONSTRAINT IF EXISTS panel_databases_db_user_key;

ALTER TABLE panel_databases
    ADD CONSTRAINT panel_databases_engine_db_name_key UNIQUE (engine, db_name);
ALTER TABLE panel_databases
    ADD CONSTRAINT panel_databases_engine_db_user_key UNIQUE (engine, db_user);

-- Down Migration
ALTER TABLE panel_databases DROP CONSTRAINT IF EXISTS panel_databases_engine_db_name_key;
ALTER TABLE panel_databases DROP CONSTRAINT IF EXISTS panel_databases_engine_db_user_key;
ALTER TABLE panel_databases DROP CONSTRAINT IF EXISTS panel_databases_engine_check;
ALTER TABLE panel_databases DROP COLUMN IF EXISTS engine;
ALTER TABLE panel_databases ADD CONSTRAINT panel_databases_db_name_key UNIQUE (db_name);
ALTER TABLE panel_databases ADD CONSTRAINT panel_databases_db_user_key UNIQUE (db_user);
