import { semsCall, todayDateString } from '../lib/sems.mjs';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, X-Sems-Email, X-Sems-Password, X-Sems-Station-Id');

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const date = (req.query.date || todayDateString()).toString();
    const { data, stationId } = await semsCall(
      req,
      'v2/PowerStationMonitor/GetPowerStationPacByDayForApp',
      { id: stationId, date },
    );
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
    return res.status(200).json({ date, samples: data?.data?.pacs ?? [] });
  } catch (err) {
    console.error('[/api/pac]', err.message);
    return res.status(err.status || 500).json({ error: err.message });
  }
}
