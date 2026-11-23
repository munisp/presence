-- Keycloak's own database (P0 dev stack). Mounted into the postgres
-- container's docker-entrypoint-initdb.d as 00_keycloak.sql so it runs before
-- the application migrations (alphabetical ordering).
CREATE DATABASE keycloak;
