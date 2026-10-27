-- Up Migration
-- AGENTS.md § 4 VERİTABANI ŞEMASI (POSTGRESQL) ile birebir.

CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE domains (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    domain_name VARCHAR(255) UNIQUE NOT NULL,
    directory_path VARCHAR(512) NOT NULL,
    ssl_status BOOLEAN DEFAULT FALSE,
    ssl_expiry TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE dns_records (
    id SERIAL PRIMARY KEY,
    domain_id INT REFERENCES domains(id) ON DELETE CASCADE,
    record_type VARCHAR(10) NOT NULL, -- A, CNAME, TXT, MX
    name VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    ttl INT DEFAULT 3600,
    cloudflare_id VARCHAR(255),
    synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Şemaya ek: auth oturumları (spesifikasyonda yok, login için gerekli — bkz. MEMORY.md).
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_domains_user_id ON domains(user_id);
CREATE INDEX idx_dns_records_domain_id ON dns_records(domain_id);

-- Down Migration
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS dns_records;
DROP TABLE IF EXISTS domains;
DROP TABLE IF EXISTS users;
