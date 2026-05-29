import { semsCall, getStationId, todayDateString } from '../lib/sems.js';

/**
 * GET /api/pac → today's intraday PAC samples for the power curve.
 * Accepts an optional ?date=YYYY-MM-DD to fetch a different day.
 */
export default async function handler(req, res) {
  try {
    const stationId = getStationId();
    const date = (req.query.date || todayDateString()).toString();

    const body = await semsCall(
      'v2/PowerStationMonitor/GetPowerStationPacByDayForApp',
      { id: stationId, date },
    );
    const pacs = body?.data?.pacs ?? [];
    res.setHeader(
      'Cache-Control',
      's-maxage=10, stale-while-revalidate=30',
    );
    return res.status(200).json({ date, samples: pacs });
  } catch (err) {
    console.error('[/api/pac]', err);
    return res
      .status(500)
      .json({ error: err.message || 'Failed to fetch power curve' });
  }
}
