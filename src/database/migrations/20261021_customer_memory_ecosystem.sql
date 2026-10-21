CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

CREATE TABLE IF NOT EXISTS customer_profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id BIGINT NOT NULL,
    chatwoot_contact_id BIGINT,
    full_name VARCHAR(255),
    email VARCHAR(255),
    phone VARCHAR(50),
    preferred_channel VARCHAR(50) DEFAULT whatsapp,
    sentiment_score NUMERIC(3,2) DEFAULT 0.0,
    tags TEXT[] DEFAULT ARRAY[]::TEXT[],
    custom_attributes JSONB DEFAULT {}::JSONB,
    summary TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    CONSTRAINT uq_customer_profiles_tenant_phone UNIQUE (tenant_id, phone)
);

CREATE TABLE IF NOT EXISTS customer_memories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id BIGINT NOT NULL,
    customer_id UUID NOT NULL REFERENCES customer_profiles(id) ON DELETE CASCADE,
    channel VARCHAR(50) NOT NULL,
    session_id VARCHAR(255),
    content TEXT NOT NULL,
    summary TEXT,
    topics TEXT[] DEFAULT ARRAY[]::TEXT[],
    metadata JSONB DEFAULT {}::JSONB,
    embedding vector(1536),
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_profiles_tenant_phone ON customer_profiles(tenant_id, phone);
CREATE INDEX IF NOT EXISTS idx_customer_profiles_tenant_chatwoot ON customer_profiles(tenant_id, chatwoot_contact_id);
CREATE INDEX IF NOT EXISTS idx_customer_memories_tenant_customer ON customer_memories(tenant_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_memories_tenant_session ON customer_memories(tenant_id, session_id);
