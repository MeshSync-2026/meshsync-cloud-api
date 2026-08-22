# MeshSync Backend

The MeshSync backend is a Node.js application built using the two-service architecture described in Section 10.5 of the Architecture Plan.

## Architecture

The backend is split into two services that share a single PostgreSQL database. Each service has its own responsibilities, while the shared database keeps the system simple to manage.

### Edge Sync Service

Located in `packages/edge-sync` and running on port `4001`, this service is responsible for handling incoming events and synchronization.

- Receives event batches from Data Mules through `POST /ingest`
- Prevents duplicate events using `INSERT ON CONFLICT DO NOTHING`
- Rebuilds projections from the event log using the fold pipeline
- Creates cloud-originated `ASSIGN` events
- Provides `GET /sync` for Data Mules to retrieve updates

### Command Center Service

Located in `packages/command-center` and running on port `4002`, this service handles the main command center operations.

It is responsible for:

- User signup and approval
- Authentication and role-based access control
- Managing `DISPATCHER` and `COMMANDER` roles
- Spatial clustering using Haversine distance
- Managing responder squads and automatic assignments
- Monitoring satellite uplink status
- Handling dispatch operations and requesting `ASSIGN` events from the Edge Sync Service

### Shared Package

The `packages/shared` package contains functionality that is used by both backend services and the mobile application.

It includes:

- Hybrid Logical Clock (HLC) implementation
- Event validation
- Event priority calculation
- The event fold pipeline used to rebuild projections

The fold pipeline filters tombstones, compacts heartbeats, sorts events using HLC, applies Last-Write-Wins (LWW) rules, and calculates confidence values.

## Running the Backend

Start both services with demo data:

```bash
node start.js