import { semsCall, resolveCredentials } from '../lib/sems.mjs';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, X-Sems-Email, X-Sems-Password, X-Sems-Station-Id');

  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const { stationId } = resolveCredentials(req);
    const { data } = await semsCall(
      req,
      'v1/PowerStation/GetMonitorDetailByPowerstationId',
      { powerStationId: stationId },
    );
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
    return res.status(200).json(data.data);
  } catch (err) {
    console.error('[/api/monitor]', err.message);
    return res.status(err.status || 500).json({ error: err.message });
  }
}
