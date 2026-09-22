// Spatial calculation utilities for incident clustering and geodesic computations
// Implements Haversine distance and 3D Cartesian spherical centroid calculation

const EARTH_RADIUS_METERS = 6371000;

/**
 * Compute the Haversine distance (great circle distance) in meters between two lat/lng points.
 *
 * @param {number} lat1 - Latitude of point 1 in degrees
 * @param {number} lng1 - Longitude of point 1 in degrees
 * @param {number} lat2 - Latitude of point 2 in degrees
 * @param {number} lng2 - Longitude of point 2 in degrees
 * @returns {number} Distance in meters
 */
export function haversineDistance(lat1, lng1, lat2, lng2) {
  if (lat1 === lat2 && lng1 === lng2) return 0;

  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lng2 - lng1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

/**
 * Compute the true spherical centroid of a group of geographic coordinates.
 * Converts lat/lng to 3D Cartesian vectors (x, y, z), averages them, and converts back.
 *
 * @param {Array<{ latitude: number, longitude: number }>} points
 * @returns {{ centroidLat: number, centroidLng: number }}
 */
export function sphericalCentroid(points) {
  if (!points || points.length === 0) {
    return { centroidLat: 0, centroidLng: 0 };
  }
  if (points.length === 1) {
    return { centroidLat: points[0].latitude, centroidLng: points[0].longitude };
  }

  let xSum = 0;
  let ySum = 0;
  let zSum = 0;

  for (const p of points) {
    const latRad = (p.latitude * Math.PI) / 180;
    const lngRad = (p.longitude * Math.PI) / 180;

    xSum += Math.cos(latRad) * Math.cos(lngRad);
    ySum += Math.cos(latRad) * Math.sin(lngRad);
    zSum += Math.sin(latRad);
  }

  const total = points.length;
  const xAvg = xSum / total;
  const yAvg = ySum / total;
  const zAvg = zSum / total;

  const hyp = Math.sqrt(xAvg * xAvg + yAvg * yAvg);
  const centroidLngRad = Math.atan2(yAvg, xAvg);
  const centroidLatRad = Math.atan2(zAvg, hyp);

  const centroidLat = (centroidLatRad * 180) / Math.PI;
  const centroidLng = (centroidLngRad * 180) / Math.PI;

  return { centroidLat, centroidLng };
}

/**
 * Cluster adjacent incidents within a distance threshold.
 *
 * @param {Array<object>} incidents
 * @param {number} thresholdMeters - Max distance to group incidents together (default 1000m)
 * @returns {Array<object>} Formed clusters
 */
export function clusterIncidents(incidents, thresholdMeters = 1000) {
  // Only cluster active incidents (status_code: 1=OPEN, 2=ASSIGNED, 3=EN_ROUTE) with coordinates
  const active = incidents.filter(
    (i) => (i.status_code === 1 || i.status_code === 2 || i.status_code === 3) &&
      i.latitude != null && i.longitude != null
  );

  if (active.length === 0) return [];

  const visited = new Set();
  const clusters = [];

  for (const inc of active) {
    if (visited.has(inc.id)) continue;
    const members = [inc];
    visited.add(inc.id);

    for (const other of active) {
      if (visited.has(other.id)) continue;
      const dist = haversineDistance(inc.latitude, inc.longitude, other.latitude, other.longitude);
      if (dist <= thresholdMeters) {
        members.push(other);
        visited.add(other.id);
      }
    }

    if (members.length >= 2) {
      const { centroidLat, centroidLng } = sphericalCentroid(members);

      // Compute radius as Haversine distance to the furthest member
      let maxDist = 0;
      for (const m of members) {
        const d = haversineDistance(centroidLat, centroidLng, m.latitude, m.longitude);
        if (d > maxDist) maxDist = d;
      }

      // Max severity among members
      const severityScore = Math.max(...members.map((m) => m.severity_level || 1));

      clusters.push({
        centroid_lat: centroidLat,
        centroid_lng: centroidLng,
        radius_meters: Math.round(maxDist),
        severity_score: severityScore,
        incident_count: members.length,
        status: "ACTIVE",
        member_ids: members.map((m) => m.id),
      });
    }
  }

  return clusters;
}
