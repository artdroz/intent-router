-- Runs once at database bootstrap, as the `postgres` superuser.
-- Change the placeholder passwords before using anywhere real.

-- pgvector extension must be created by a superuser.
CREATE EXTENSION IF NOT EXISTS vector;

-- Application role: data access only (no DDL).
CREATE ROLE app_user LOGIN PASSWORD 'app-user-password';

-- Migration role: can change the schema (DDL).
CREATE ROLE migrate_user LOGIN PASSWORD 'migrate-user-password';

GRANT CONNECT ON DATABASE "intent-router" TO app_user, migrate_user;

-- Schema access
GRANT USAGE ON SCHEMA public TO app_user, migrate_user;
GRANT CREATE ON SCHEMA public TO migrate_user;

-- App role: DML on existing tables
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- Migration role: full control on existing tables/sequences
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO migrate_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO migrate_user;

-- Tables created later by the migration role are automatically usable by the app role.
ALTER DEFAULT PRIVILEGES FOR ROLE migrate_user IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE migrate_user IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;
