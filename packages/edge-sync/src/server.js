// Edge Sync Service — HTTP + WebSocket server
// Architecture Plan 
//
// Endpoints:
//   POST /ingest          — receive event batch from Data Mule
//   GET  /sync            — pull events above HLC watermark
//   GET  /incidents       — list incidents (projection)
//   GET  /incidents/:id   — get single incident
//   GET  /incidents/:id/events — get events for an incident
//   GET  /incidents/:id/responders — get responders for an incident
//   GET  /incidents/:id/history — get history for an incident
//   GET  /events          — list all events (with optional filters)
//   GET  /assignments     — list assignments (projection)
//   GET  /batches         — list ingestion batches
//   GET  /batches/:id/items — list items for a batch
//   POST /internal/assign — emit ASSIGN event (called by Command Center Service)
//   GET  /health          — health check
//   WS   /ws              — WebSocket for real-time event push to mobile clients

import http from "node:http";
import crypto from "node:crypto";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPgPool } from "@meshsync/shared/db";
import { EVENT_TYPE } from "@meshsync/shared/enums";
import { createDb } from "./db.js";

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB limit
const RANDOM_DEV_SECRET = crypto.randomBytes(32).toString("hex");

export function getInternalApiSecret() {
    if (process.env.INTERNAL_API_SECRET) return process.env.INTERNAL_API_SECRET;
    if (process.env.NODE_ENV === "production") {
        throw new Error("[Security] INTERNAL_API_SECRET environment variable is required in production mode.");
    }
    return RANDOM_DEV_SECRET;
}

export function createServer(db = null) {
    let database = db;
    if (!database) {
        if (process.env.DATABASE_URL) {
            database = createDb(true, createPgPool(process.env.DATABASE_URL));
        } else {
            database = createDb(false);
        }
    }

    // --- WebSocket clients (for real-time event push to phones) ---
    const wsClients = new Set();

    // Server-side keepalive: send ping every 30s, kill dead clients after 60s
    const keepaliveInterval = setInterval(() => {
        for (const client of wsClients) {
            if (!client.writable) {
                wsClients.delete(client);
                continue;
            }
            try {
                // Send a ping frame (opcode 0x9) with empty payload
                client.write(buildWsFrame(Buffer.alloc(0), 0x9));
            } catch {
                wsClients.delete(client);
            }
        }
    }, 30000);

    function broadcastToWsClients(message, excludeNode = null) {
        const data = JSON.stringify(message);
        let sent = 0;
        for (const client of wsClients) {
            if (!client.writable) continue; // raw TCP socket, not WebSocket API
            if (excludeNode && client.nodeId === excludeNode) continue;
            try {
                client.write(buildWsFrame(data));
                sent++;
            } catch (e) {
                // Client disconnected during write
                wsClients.delete(client);
            }
        }
        return sent;
    }

    function handleWsUpgrade(req, socket) {
        // WebSocket handshake
        const key = req.headers["sec-websocket-key"];
        if (!key) {
            socket.destroy();
            return;
        }

        const accept = crypto
            .createHash("sha1")
            .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
            .digest("base64");

        socket.write(
            "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n` +
            "\r\n"
        );

        // Track this client
        const client = socket;
        client.nodeId = null;
        client.isAlive = true;
        // Set a 120s timeout — if no data received, the connection is dead
        client.setTimeout(120000);
        client.on("timeout", () => {
            console.log(`[WS] Client timeout (node: ${client.nodeId || "unregistered"})`);
            wsClients.delete(client);
            try { client.destroy(); } catch { }
        });
        wsClients.add(client);

        console.log(`[WS] Client connected (${wsClients.size} total)`);

        // Parse incoming WebSocket frames
        let buffer = Buffer.alloc(0);

        client.on("data", async (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            while (buffer.length >= 2) {
                const frame = parseWsFrame(buffer);
                if (!frame) break;
                buffer = buffer.slice(frame.totalLength);

                if (frame.opcode === 0x8) {
                    // Close frame
                    wsClients.delete(client);
                    client.destroy();
                    return;
                }

                if (frame.opcode === 0x9) {
                    // Ping frame — respond with pong (keepalive)
                    client.write(buildWsFrame(frame.payload, 0xA));
                    continue;
                }

                if (frame.opcode === 0xA) {
                    // Pong frame — client is alive, no action needed
                    client.isAlive = true;
                    continue;
                }

                if (frame.opcode === 0x1 && frame.payload) {
                    // Text message
                    try {
                        const msg = JSON.parse(frame.payload.toString());
                        if (msg.type === "register" && msg.nodeId) {
                            client.nodeId = msg.nodeId;
                            console.log(`[WS] Registered node: ${msg.nodeId}`);

                            // Send current events as initial sync
                            const events = await database.getSyncEvents(null);
                            console.log(`[WS] Sending initial sync: ${events.length} events to node ${msg.nodeId}`);
                            client.write(
                                buildWsFrame(JSON.stringify({ type: "events", events }))
                            );
                        } else if (msg.type === "ping") {
                            // Client keepalive — respond with pong
                            client.write(buildWsFrame(JSON.stringify({ type: "pong" })));
                        } else if (msg.type === "events" && msg.events) {
                            // Phone is pushing events via WebSocket
                            const result = await database.ingestEvents(msg.events, client.nodeId || "ws-client");

                            // Broadcast only canonical events (inserted or already
                            // known). Rejected rows must never reach other phones.
                            const okIds = new Set(
                                (result.items || [])
                                    .filter((it) => it.outcome === "inserted" || it.outcome === "duplicate_ignored")
                                    .map((it) => it.row_id)
                            );
                            const acceptedEvents = msg.events.filter((e) => e && okIds.has(e.id));
                            if (acceptedEvents.length > 0) {
                                broadcastToWsClients(
                                    { type: "events", events: acceptedEvents },
                                    client.nodeId
                                );
                            }

                            console.log(`[WS] Node ${client.nodeId}: ingested ${result.newCount} new, ${result.duplicateCount} dup, broadcasting ${acceptedEvents.length} to ${wsClients.size - 1} peers`);

                            // Acknowledge
                            client.write(
                                buildWsFrame(JSON.stringify({
                                    type: "ack",
                                    pushed: result.newCount,
                                    duplicates: result.duplicateCount,
                                }))
                            );
                        }
                    } catch (e) {
                        // Ignore malformed messages
                    }
                }
            }
        });

        client.on("close", () => {
            wsClients.delete(client);
            console.log(`[WS] Client disconnected (${wsClients.size} total)`);
        });

        client.on("error", () => {
            wsClients.delete(client);
        });
    }

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, `http://${req.headers.host}`);
            const path = url.pathname;
            const method = req.method;

            // CORS headers
            const allowedOrigin = process.env.CORS_ORIGIN || "*";
            res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-internal-token");
            if (method === "OPTIONS") {
                res.writeHead(204);
                res.end();
                return;
            }

            res.setHeader("Content-Type", "application/json");

            // --- Health ---
            if (path === "/health" && method === "GET") {
                res.writeHead(200);
                res.end(JSON.stringify({ status: "ok", service: "edge-sync", wsClients: wsClients.size, timestamp: Date.now() }));
                return;
            }

            // --- POST /ingest ---
            if (path === "/ingest" && method === "POST") {
                const body = await readBody(req);
                let parsed;
                try {
                    parsed = JSON.parse(body);
                } catch {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: "Invalid JSON" }));
                    return;
                }

                if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.events)) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: "Invalid payload: 'events' array is required" }));
                    return;
                }

                const events = parsed.events || [];
                const uploadingNodeId = parsed.uploading_node_id || "unknown";
                const result = await database.ingestEvents(events, uploadingNodeId);

                // Broadcast only canonical events (inserted or already known) —
                // rejected rows must never reach connected phones.
                const okIds = new Set(
                    (result.items || [])
                        .filter((it) => it.outcome === "inserted" || it.outcome === "duplicate_ignored")
                        .map((it) => it.row_id)
                );
                const acceptedEvents = events.filter((e) => e && okIds.has(e.id));
                if (acceptedEvents.length > 0) {
                    broadcastToWsClients(
                        { type: "events", events: acceptedEvents },
                        null // don't exclude — HTTP ingest has no WS node identity
                    );
                }

                const ackIds = (result.items || [])
                    .filter((it) => it.outcome === "inserted" || it.outcome === "duplicate_ignored")
                    .map((it) => it.row_id)
                    .filter(Boolean);

                console.log(JSON.stringify({
                    level: "info",
                    service: "edge-sync",
                    action: "ingest_batch",
                    uploading_node_id: uploadingNodeId,
                    batch_id: result.batch.id,
                    new_count: result.newCount,
                    duplicate_count: result.duplicateCount,
                    rejected_count: result.rejectedCount,
                    ack_count: ackIds.length,
                    timestamp: new Date().toISOString()
                }));

                res.writeHead(200);
                res.end(JSON.stringify({
                    batch_id: result.batch.id,
                    is_cloud_synced: true,
                    new_count: result.newCount,
                    duplicate_count: result.duplicateCount,
                    rejected_count: result.rejectedCount,
                    ack_ids: ackIds,
                    items: result.items,
                }));
                return;
            }

            // --- GET /sync ---
            if (path === "/sync" && method === "GET") {
                const sinceHlc = url.searchParams.get("since_hlc");
                const events = await database.getSyncEvents(sinceHlc);
                res.writeHead(200);
                res.end(JSON.stringify({ events, count: events.length }));
                return;
            }

            // --- GET /incidents ---
            if (path === "/incidents" && method === "GET") {
                const filters = {};
                const status = url.searchParams.get("status_code");
                const confidence = url.searchParams.get("confidence_code");
                const zoneId = url.searchParams.get("zone_id");
                if (status) filters.status_code = parseInt(status, 10);
                if (confidence) filters.confidence_code = parseInt(confidence, 10);
                if (zoneId) filters.zone_id = zoneId;
                const incidents = await database.getIncidents(filters);
                res.writeHead(200);
                res.end(JSON.stringify({ incidents, count: incidents.length }));
                return;
            }

            // --- GET /incidents/:id ---
            const incidentMatch = path.match(/^\/incidents\/([^/]+)$/);
            if (incidentMatch && method === "GET") {
                const incident = await database.getIncidentById(incidentMatch[1]);
                if (!incident) {
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: "Incident not found" }));
                    return;
                }
                res.writeHead(200);
                res.end(JSON.stringify(incident));
                return;
            }

            // --- GET /incidents/:id/events ---
            const eventsMatch = path.match(/^\/incidents\/([^/]+)\/events$/);
            if (eventsMatch && method === "GET") {
                const events = await database.getEventsByIncident(eventsMatch[1]);
                res.writeHead(200);
                res.end(JSON.stringify({ events, count: events.length }));
                return;
            }

            // --- GET /incidents/:id/responders ---
            const respondersMatch = path.match(/^\/incidents\/([^/]+)\/responders$/);
            if (respondersMatch && method === "GET") {
                const responders = await database.getRespondersByIncident(respondersMatch[1]);
                res.writeHead(200);
                res.end(JSON.stringify({ responders, count: responders.length }));
                return;
            }

            // --- GET /incidents/:id/history ---
            const historyMatch = path.match(/^\/incidents\/([^/]+)\/history$/);
            if (historyMatch && method === "GET") {
                const history = await database.getHistoryByIncident(historyMatch[1]);
                res.writeHead(200);
                res.end(JSON.stringify({ history, count: history.length }));
                return;
            }

            // --- GET /events ---
            if (path === "/events" && method === "GET") {
                const filters = {};
                const typeCode = url.searchParams.get("event_type_code");
                const incidentId = url.searchParams.get("incident_id");
                const sinceHlc = url.searchParams.get("since_hlc");
                if (typeCode) filters.event_type_code = parseInt(typeCode, 10);
                if (incidentId) filters.incident_id = incidentId;
                if (sinceHlc) filters.since_hlc = sinceHlc;
                const events = await database.getMeshEvents(filters);
                res.writeHead(200);
                res.end(JSON.stringify({ events, count: events.length }));
                return;
            }

            // --- GET /assignments ---
            if (path === "/assignments" && method === "GET") {
                const assignments = await database.getAssignments();
                res.writeHead(200);
                res.end(JSON.stringify({ assignments, count: assignments.length }));
                return;
            }

            // --- GET /batches ---
            if (path === "/batches" && method === "GET") {
                const batches = await database.getBatches();
                res.writeHead(200);
                res.end(JSON.stringify({ batches, count: batches.length }));
                return;
            }

            // --- GET /batches/:id/items ---
            const batchItemsMatch = path.match(/^\/batches\/([^/]+)\/items$/);
            if (batchItemsMatch && method === "GET") {
                const items = await database.getBatchItems(batchItemsMatch[1]);
                res.writeHead(200);
                res.end(JSON.stringify({ items, count: items.length }));
                return;
            }

            // --- POST /internal/assign (called by Command Center Service) ---
            if (path === "/internal/assign" && method === "POST") {
                const internalToken = req.headers["x-internal-token"];
                let expectedSecret;
                try {
                    expectedSecret = getInternalApiSecret();
                } catch (err) {
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: err.message }));
                    return;
                }

                if (!internalToken || internalToken !== expectedSecret) {
                    res.writeHead(403);
                    res.end(JSON.stringify({ error: "Forbidden: invalid internal token" }));
                    return;
                }

                const body = await readBody(req);
                let parsed;
                try {
                    parsed = JSON.parse(body);
                } catch {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: "Invalid JSON" }));
                    return;
                }
                if (!parsed.target_node_id || !parsed.target_zone_id) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: "target_node_id and target_zone_id are required" }));
                    return;
                }
                const event = await database.emitAssignEvent({
                    targetNodeId: parsed.target_node_id,
                    targetZoneId: parsed.target_zone_id,
                    incidentId: parsed.incident_id,
                    assignedByAdminId: parsed.assigned_by_admin_id,
                });
                // Push to live WS clients so connected phones get the ASSIGN now,
                // not only on their next /sync pull.
                broadcastToWsClients({ type: "events", events: [event] }, null);
                res.writeHead(201);
                res.end(JSON.stringify(event));
                return;
            }

            // --- POST /internal/event — cloud-origin SOS_RESOLVED / SOS_CANCELLED ---
            if (path === "/internal/event" && method === "POST") {
                const internalToken = req.headers["x-internal-token"];
                let expectedSecret;
                try {
                    expectedSecret = getInternalApiSecret();
                } catch (err) {
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: err.message }));
                    return;
                }
                if (!internalToken || internalToken !== expectedSecret) {
                    res.writeHead(403);
                    res.end(JSON.stringify({ error: "Forbidden: invalid internal token" }));
                    return;
                }

                const body = await readBody(req);
                let parsed;
                try {
                    parsed = JSON.parse(body);
                } catch {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: "Invalid JSON" }));
                    return;
                }
                if (!parsed.incident_id) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: "incident_id is required" }));
                    return;
                }
                const typeCode = parsed.event_type_code;
                if (![EVENT_TYPE.SOS_RESOLVED, EVENT_TYPE.SOS_CANCELLED].includes(typeCode)) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: "event_type_code must be 5 (SOS_RESOLVED) or 6 (SOS_CANCELLED)" }));
                    return;
                }
                const event = await database.emitStatusEvent({
                    incidentId: parsed.incident_id,
                    eventTypeCode: typeCode,
                });
                if (!event) {
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: "Incident not found" }));
                    return;
                }
                broadcastToWsClients({ type: "events", events: [event] }, null);
                res.writeHead(201);
                res.end(JSON.stringify(event));
                return;
            }

            // --- 404 ---
            res.writeHead(404);
            res.end(JSON.stringify({ error: "Not found", path }));
        } catch (err) {
            console.error("Edge Sync error:", err);
            const status = err.statusCode || err.status || 500;
            res.writeHead(status);
            const responseBody = status >= 500
                ? { error: "Internal server error" }
                : { error: err.message };
            res.end(JSON.stringify(responseBody));
        }
    });

    // Register WebSocket upgrade event on the server
    server.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        if (url.pathname === "/ws") {
            handleWsUpgrade(req, socket);
        } else {
            socket.destroy();
        }
    });

    // Clear keepalive interval when server closes
    server.on("close", () => {
        clearInterval(keepaliveInterval);
    });

    return { server, db: database };
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalBytes = 0;

        req.on("data", (chunk) => {
            totalBytes += chunk.length;
            if (totalBytes > maxBytes) {
                const err = new Error("Payload Too Large");
                err.statusCode = 413;
                req.destroy(err);
                reject(err);
                return;
            }
            chunks.push(chunk);
        });

        req.on("end", () => {
            const rawBuffer = Buffer.concat(chunks);
            const encoding = (req.headers["content-encoding"] || "").toLowerCase();

            try {
                if (encoding === "gzip" || encoding === "x-gzip") {
                    const decompressed = zlib.gunzipSync(rawBuffer, { maxOutputLength: maxBytes });
                    resolve(decompressed.toString("utf8"));
                } else if (encoding === "deflate") {
                    const decompressed = zlib.inflateSync(rawBuffer, { maxOutputLength: maxBytes });
                    resolve(decompressed.toString("utf8"));
                } else if (encoding === "br") {
                    const decompressed = zlib.brotliDecompressSync(rawBuffer, { maxOutputLength: maxBytes });
                    resolve(decompressed.toString("utf8"));
                } else {
                    resolve(rawBuffer.toString("utf8"));
                }
            } catch (decompErr) {
                const isTooLarge = decompErr.code === "ERR_BUFFER_TOO_LARGE" || decompErr.message?.includes("output length");
                const err = new Error(`Decompression failed (${encoding}): ${decompErr.message}`);
                err.statusCode = isTooLarge ? 413 : 400;
                reject(err);
            }
        });

        req.on("error", reject);
    });
}

// --- WebSocket frame helpers ---

function buildWsFrame(payload, opcode = 0x1) {
    const payloadBytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
    const mask = false; // server-to-client frames are not masked
    const finOpcode = 0x80 | opcode; // FIN bit + opcode
    let header;

    if (payloadBytes.length < 126) {
        header = Buffer.alloc(2);
        header[0] = finOpcode;
        header[1] = mask ? 0x80 | payloadBytes.length : payloadBytes.length;
    } else if (payloadBytes.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = finOpcode;
        header[1] = mask ? 0x80 | 126 : 126;
        header.writeUInt16BE(payloadBytes.length, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = finOpcode;
        header[1] = mask ? 0x80 | 127 : 127;
        header.writeUInt32BE(0, 2);
        header.writeUInt32BE(payloadBytes.length, 6);
    }

    return Buffer.concat([header, payloadBytes]);
}

function parseWsFrame(buffer) {
    if (buffer.length < 2) return null;

    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let payloadLen = buffer[1] & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
        if (buffer.length < 4) return null;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
    } else if (payloadLen === 127) {
        if (buffer.length < 10) return null;
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset = 10;
    }

    let maskKey = null;
    if (masked) {
        if (buffer.length < offset + 4) return null;
        maskKey = buffer.slice(offset, offset + 4);
        offset += 4;
    }

    if (buffer.length < offset + payloadLen) return null;

    let payload = buffer.slice(offset, offset + payloadLen);
    if (masked && maskKey) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) {
            payload[i] ^= maskKey[i % 4];
        }
    }

    return {
        opcode,
        payload,
        totalLength: offset + payloadLen,
    };
}

// Start server if run directly
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    const port = process.env.PORT || process.env.EDGE_SYNC_PORT || 4001;
    const { runStartupMigration } = await import("../../../migrations/migrate.js");
    await runStartupMigration(true);
    const { server } = createServer();
    server.listen(port, () => {
        console.log(`Edge Sync Service running on http://localhost:${port}`);
    });
}

export default { createServer };