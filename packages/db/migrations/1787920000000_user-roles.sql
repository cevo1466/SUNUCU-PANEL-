-- Up Migration
-- Domain başına ayrı müşteri girişi: ana panel admin hesabından farklı,
-- yalnızca kendi domain(ler)ini gören bir "customer" rolü ekleniyor.
-- Mevcut satırlar (tek yönetici) 'admin' kalır — davranış değişmez.

ALTER TABLE users
    ADD COLUMN role VARCHAR(16) NOT NULL DEFAULT 'admin';

ALTER TABLE users
    ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'customer'));

-- Down Migration
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users DROP COLUMN IF EXISTS role;
