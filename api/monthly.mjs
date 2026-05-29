import { semsCall, resolveCredentials, todayDateString } from '../lib/sems.mjs';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, X-Sems-Email, X-Sems-Password, X-Sems-Station-Id');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const { stationId } = resolveCredentials(req);
    const date = (req.query.date || todayDateString()).toString();
    const { data } = await semsCall(req, 'v2/Charts/GetChartByPlant', {
      id: stationId, date, range: '3', chartIndexId: '3', isDetailFull: '',
    });

    // Mirror Flutter's _parseChartByPlant: find the kWh / PVGeneration line
    const lines = data?.data?.lines || [];
    let xy = [];
    if (lines.length > 0) {
      const pvLine = lines.find(l =>
        (l.unit || '').toLowerCase() === 'kwh' ||
        (l.name || '').toLowerCase().includes('generation') ||
        (l.name || '').toLowerCase().includes('pv')
      ) || lines[0];
      xy = (pvLine?.xy || []).map(pt => ({ label: pt.x, kwh: +(pt.y) || 0 }));
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({ samples: xy });
  } catch (err) {
    console.error('[/api/monthly]', err.message);
    return res.status(err.status || 500).json({ error: err.message });
  }
}
