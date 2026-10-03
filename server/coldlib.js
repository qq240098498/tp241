// 温控口径都集中在这里：超限段、断链、MKT、放行判定。
// 判定核心是纯函数 evaluate(rows, probes, settings)：
// 给定同样的记录、探头清单、口径参数，必算出同样的结论与逐条依据，供快照复算使用。
const store = require('./store');

// 快照里固化的口径字段（温度带、单次/累计允许超限、断链门槛、记录间隔）
const CALIBRATION_SETTING_KEYS = [
  'lowerLimitC', 'upperLimitC',
  'allowExcursionMinutes', 'allowTotalExcursionMinutes',
  'chainGapMinutes', 'recordIntervalMinutes',
];
const SETTING_KEYS = CALIBRATION_SETTING_KEYS.concat([
  'mktActivationEnergy', 'gasConstant', 'probeCalibrationGraceDays',
]);
const CALC_VERSION = '2026-10-03';

function toDate(text) {
  return new Date(String(text).replace(' ', 'T') + '+08:00');
}

function numSettings(settings) {
  const out = {};
  for (const key of SETTING_KEYS) out[key] = Number(settings[key]);
  return out;
}

// 固化判定口径：数值转成 Number，防止 db.json 里字符串/数字口径复算结果不一致
function frozenSettings(settings) {
  const out = {};
  for (const key of SETTING_KEYS) out[key] = Number(settings[key]);
  return out;
}

function recordsOfBatch(data, batchId) {
  return data.records
    .filter((r) => r.batchId === batchId)
    .slice()
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function probeOf(data, probeId) {
  return data.probes.find((p) => p.id === probeId) || null;
}

// 同一探头同一时刻既有自动记录又有手工更正时，以手工为准
function effectiveRecords(data, batchId) {
  const rows = recordsOfBatch(data, batchId);
  const picked = {};
  const order = [];
  for (const row of rows) {
    const key = row.probeId + '|' + row.at;
    if (picked[key] === undefined) {
      picked[key] = row;
      order.push(key);
      continue;
    }
    const current = picked[key];
    if (current.source === '自动' && row.source === '人工') picked[key] = row;
  }
  return order.map((key) => picked[key]);
}

// 逐条取值：纯函数，供页面与快照复算共用。
// rows 需已按时刻升序（同一时刻再按探头排序），输出同样顺序。
function evalRows(rows, settings) {
  const s = numSettings(settings);
  const outOfRange = (value) => value > s.upperLimitC || value < s.lowerLimitC;
  const probeSegment = {};   // probeId -> 当前连续超限段
  const probePrevAt = {};    // probeId -> 上一条时刻
  const detail = [];

  for (const row of rows) {
    const value = Number(row.temperatureC);
    const out = outOfRange(value);
    const probeId = row.probeId;

    // 断链：与同一探头上一条记录的实际时刻差超过门槛
    let gapMinutes = null;
    if (probePrevAt[probeId] !== undefined) {
      gapMinutes = store.minutesBetween(probePrevAt[probeId], row.at);
    }
    const gap = gapMinutes !== null && gapMinutes > s.chainGapMinutes;

    // 超限：回到范围内即断开；段时长按固定记录间隔累计
    let segmentMinutes = 0;
    if (out) {
      const seg = probeSegment[probeId];
      if (seg) {
        seg.minutes += s.recordIntervalMinutes;
        seg.endAt = row.at;
        seg.peakC = value > seg.peakC ? value : seg.peakC;
        seg.points += 1;
        segmentMinutes = seg.minutes;
      } else {
        probeSegment[probeId] = { startAt: row.at, endAt: row.at, minutes: 0, peakC: value, points: 1 };
      }
    } else {
      probeSegment[probeId] = null;
    }

    detail.push({
      recordId: row.id,
      probeId: probeId,
      at: row.at,
      temperatureC: value,
      source: row.source,
      operator: row.operator || '',
      outOfRange: out,
      segmentMinutes: segmentMinutes,
      gapMinutes: gapMinutes,
      gap: gap,
    });

    probePrevAt[probeId] = row.at;
  }
  return detail;
}

// 按记录顺序重建超限段（与 evalRows 的累计规则一致），同一探头连续超限为一段
function buildSegments(rows, settings) {
  const s = numSettings(settings);
  const segments = [];
  const current = {};
  const sorted = rows.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : (a.probeId < b.probeId ? -1 : 1)));
  for (const row of sorted) {
    const value = Number(row.temperatureC);
    const out = value > s.upperLimitC || value < s.lowerLimitC;
    if (out) {
      const seg = current[row.probeId];
      if (seg) {
        seg.minutes += s.recordIntervalMinutes;
        seg.endAt = row.at;
        seg.peakC = value > seg.peakC ? value : seg.peakC;
        seg.points += 1;
      } else {
        current[row.probeId] = { startAt: row.at, endAt: row.at, minutes: 0, peakC: value, points: 1, probeId: row.probeId };
        segments.push(current[row.probeId]);
      }
    } else {
      current[row.probeId] = null;
    }
  }
  return segments;
}

function buildChainGaps(rows, settings) {
  const s = numSettings(settings);
  const gaps = [];
  const byProbe = {};
  const sorted = rows.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : (a.probeId < b.probeId ? -1 : 1)));
  for (const row of sorted) {
    const prev = byProbe[row.probeId];
    if (prev) {
      const minutes = store.minutesBetween(prev.at, row.at);
      if (minutes > s.chainGapMinutes) {
        gaps.push({ probeId: row.probeId, from: prev.at, to: row.at, minutes: minutes, countedMinutes: s.recordIntervalMinutes });
      }
    }
    byProbe[row.probeId] = row;
  }
  return gaps;
}

// 探头校准宽限期：支持「到期后 N 天内仍算有效」
function probeValidOn(probe, day, graceDays) {
  if (!probe || !probe.calibratedUntil) return true;
  const until = toDate(String(probe.calibratedUntil) + ' 23:59:59').getTime();
  const grace = (Number(graceDays) || 0) * 24 * 3600 * 1000;
  return toDate(String(day) + ' 00:00:00').getTime() <= until + grace;
}

// 判定核心：传入参与判定的记录、探头清单（判定时点快照）、口径参数，
// 返回四条判据各自的结论、实际值、阈值与依据记录。
function evaluate(rows, probes, settings) {
  const s = numSettings(settings);
  const probeMap = {};
  for (const p of probes || []) probeMap[p.id] = p;

  const sorted = rows.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : (a.probeId < b.probeId ? -1 : 1)));
  const detail = evalRows(sorted, s);
  const segments = buildSegments(sorted, s);
  const gaps = buildChainGaps(sorted, s);

  const longestMinutes = segments.reduce((acc, seg) => (seg.minutes > acc ? seg.minutes : acc), 0);
  const totalMinutes = segments.reduce((acc, seg) => acc + seg.minutes, 0);
  const gapCount = gaps.length;

  const values = sorted.map((r) => Number(r.temperatureC));
  const mkt = values.length ? store.round(values.reduce((acc, v) => acc + v, 0) / values.length, 2) : 0;

  // 探头上的判定：校准是否有效（依据该探头最早的记录时刻）、是否停用、记录时刻清单
  const probeFacts = {};
  for (const row of sorted) {
    let fact = probeFacts[row.probeId];
    if (!fact) {
      fact = { probeId: row.probeId, times: [], valid: true, calibratedUntil: '', inactive: false };
      probeFacts[row.probeId] = fact;
    }
    fact.times.push(row.at);
  }
  const probeResults = Object.keys(probeFacts).sort().map((probeId) => {
    const fact = probeFacts[probeId];
    const probe = probeMap[probeId] || null;
    const firstAt = fact.times.slice().sort()[0];
    const valid = probeValidOn(probe, String(firstAt).slice(0, 10), s.probeCalibrationGraceDays);
    const inactive = !!probe && probe.status !== '在用';
    fact.valid = valid;
    fact.calibratedUntil = probe ? probe.calibratedUntil : '';
    fact.inactive = inactive;
    return {
      probeId: probeId,
      probeCode: probe ? probe.code : probeId,
      status: probe ? probe.status : '探头已不在清单',
      calibratedUntil: probe ? probe.calibratedUntil : '',
      firstRecordAt: firstAt,
      recordCount: fact.times.length,
      calibrationValid: valid,
      inUse: !inactive,
    };
  });
  const invalidProbes = probeResults.filter((p) => !p.calibrationValid || !p.inUse);

  const conditions = [
    {
      key: 'longest',
      ok: longestMinutes <= s.allowExcursionMinutes,
      value: longestMinutes,
      limit: s.allowExcursionMinutes,
      text: '单次连续超限不超过 ' + s.allowExcursionMinutes + ' 分钟',
      basis: {
        segmentCount: segments.length,
        segments: segments.map((seg) => ({
          probeId: seg.probeId, startAt: seg.startAt, endAt: seg.endAt,
          minutes: seg.minutes, peakC: seg.peakC, points: seg.points,
        })),
      },
    },
    {
      key: 'total',
      ok: totalMinutes <= s.allowTotalExcursionMinutes,
      value: totalMinutes,
      limit: s.allowTotalExcursionMinutes,
      text: '累计超限不超过 ' + s.allowTotalExcursionMinutes + ' 分钟',
      basis: {
        segmentCount: segments.length,
        segments: segments.map((seg) => ({
          probeId: seg.probeId, startAt: seg.startAt, endAt: seg.endAt,
          minutes: seg.minutes, peakC: seg.peakC, points: seg.points,
        })),
      },
    },
    {
      key: 'chain',
      ok: gapCount === 0,
      value: gapCount,
      limit: 0,
      text: '全程没有断链',
      basis: {
        gaps: gaps,
        totalGapMinutes: gaps.reduce((acc, g) => acc + g.countedMinutes, 0),
      },
    },
    {
      key: 'calibration',
      ok: invalidProbes.length === 0,
      value: invalidProbes.length,
      limit: 0,
      text: '参与判定的探头都在用且在校准有效期内',
      basis: { probes: probeResults },
    },
  ];

  return {
    calcVersion: CALC_VERSION,
    mkt: mkt,
    longestMinutes: longestMinutes,
    totalMinutes: totalMinutes,
    recordCount: sorted.length,
    firstAt: sorted.length ? sorted[0].at : '',
    lastAt: sorted.length ? sorted[sorted.length - 1].at : '',
    segments: segments,
    chainGaps: gaps,
    records: detail,
    probes: probeResults,
    expiredProbes: invalidProbes.map((p) => ({
      probeId: p.probeId, probeCode: p.probeCode, calibratedUntil: p.calibratedUntil, at: p.firstRecordAt,
    })),
    conditions: conditions,
    pass: conditions.every((c) => c.ok),
    failed: conditions.filter((c) => !c.ok).map((c) => c.key),
  };
}

// 以当前数据库状态（当前口径、当前探头清单、当前有效记录）做一次判定
function releaseCheck(data, batch) {
  const rows = effectiveRecords(data, batch.id);
  return evaluate(rows, data.probes, data.settings);
}

// 供批次详情页使用的命名别名
function excursionStats(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  const s = numSettings(data.settings);
  const segments = buildSegments(rows, s);
  return {
    segments: segments,
    longestMinutes: segments.reduce((acc, seg) => (seg.minutes > acc ? seg.minutes : acc), 0),
    longest: segments.reduce((acc, seg) => (seg.minutes > acc.minutes ? seg : acc), { minutes: 0, startAt: '', endAt: '', peakC: 0, points: 0 }),
    totalMinutes: segments.reduce((acc, seg) => acc + seg.minutes, 0),
    segmentCount: segments.length,
    recordCount: rows.length,
    firstAt: rows.length ? rows[0].at : '',
    lastAt: rows.length ? rows[rows.length - 1].at : '',
  };
}

function chainGaps(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  const gaps = buildChainGaps(rows, data.settings);
  return { gaps: gaps, gapCount: gaps.length, totalGapMinutes: gaps.reduce((acc, g) => acc + g.countedMinutes, 0) };
}

function mktCelsius(data, batchId) {
  return releaseCheck(data, { id: batchId }).mkt;
}

function expiredProbes(data, batchId, day) {
  const rows = effectiveRecords(data, batchId);
  const bad = [];
  for (const row of rows) {
    const probe = probeOf(data, row.probeId);
    if (!probe) continue;
    if (!probeValidOn(probe, String(row.at).slice(0, 10), data.settings.probeCalibrationGraceDays)) {
      if (!bad.some((b) => b.probeCode === probe.code)) {
        bad.push({ probeId: probe.id, probeCode: probe.code, calibratedUntil: probe.calibratedUntil, at: row.at });
      }
    }
  }
  return bad;
}

module.exports = {
  toDate,
  probeOf,
  recordsOfBatch,
  effectiveRecords,
  evalRows,
  evaluate,
  frozenSettings,
  releaseCheck,
  excursionStats,
  chainGaps,
  mktCelsius,
  probeValidOn,
  expiredProbes,
  CALC_VERSION,
  CALIBRATION_SETTING_KEYS,
  SETTING_KEYS,
};
