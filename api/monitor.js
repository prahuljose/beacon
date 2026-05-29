import { semsCall, getStationId } from '../lib/sems.js';

/**
 * GET /api/monitor → live station KPIs + inverter snapshot.
 * Returns the `data` block from SEMS' GetMonitorDetailByPowerstationId.
 */
export default async function handler(req, res) {
  try {
    const stationId = getStationId();
    const body = await semsCall(
      'v1/PowerStation/GetMonitorDetailByPowerstationId',
      { powerStationId: stationId },
    );
    // Edge cache so rapid client polls (15s) don't hammer SEMS during a warm window
    res.setHeader(
      'Cache-Control',
      's-maxage=10, stale-while-revalidate=30',
    );
    return res.status(200).json(body.data);
  } catch (err) {
    console.error('[/api/monitor]', err);
    return res
      .status(500)
      .json({ error: err.message || 'Failed to fetch monitor data' });
  }
}
