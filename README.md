# MeshSync Cloud API

The **MeshSync Cloud API** is the Node.js and Express backend for the MeshSync disaster response platform. It manages cloud side data persistence, ingestion of offline event batches carried by Data Mules, and the REST APIs for the Command Center dashboard.

### What this repository does:
* **Event Ingestion & Edge Sync**: Idempotently ingests mesh events from Data Mules, rebuilds incident projections, and propagates sync acknowledgments back to the field.
* **Command Center API**: Serves dashboard endpoints for authentication, incident tracking, responder dispatches, spatial clustering, and device revocation.
* **CRDT & Causal Engine**: Implements Hybrid Logical Clock (HLC) ordering and the deterministic 5 stage fold pipeline to guarantee eventual consistency across replicas.
* **Database Migrations**: Maintains the PostgreSQL relational schema for the immutable event log, derived projections, clusters, and audit trails.
