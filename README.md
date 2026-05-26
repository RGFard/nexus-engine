# Canonical Schema Service

Standalone JSON Schema registry and validation service for canonical domain models (shipment, shared components, and future domains).

## Features

- Schema loading, retrieval, and versioning
- AJV-based validation with extensible `extensions` fields
- REST API with OpenAPI documentation
- Structured logging (Pino)
- Modular architecture for future AI mapping integration

## Quick start

```bash
npm install
npm run dev
```

- API: http://localhost:3000
- OpenAPI UI: http://localhost:3000/documentation

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/schemas` | List all registered schemas |
| GET | `/schemas/:domain/:schemaName` | Get a schema (`?version=` optional) |
| POST | `/schemas/validate` | Validate a payload against a schema |

## Project layout

```
schemas/          # JSON Schema source files
  shared/         # Reusable components
  shipment/       # Shipment domain schemas
src/
  routes/         # HTTP route handlers
  services/       # Schema registry, validation, AI-mapping hooks
  models/         # Types and DTOs
  utils/          # Logging, paths, helpers
```
