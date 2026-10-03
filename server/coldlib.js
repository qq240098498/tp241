// 温控口径都集中在这里：超限段、断链、MKT、放行判定。
// 判定核心是纯函数 evaluate(batch, settings, records, probes)：
// 入参全部显式给定（冻结的口径参数、参与判定的原始记录、探头清单），
// 出参带逐条记录的取值依据，因此任何一份历史快照都能用同一版本引擎原样复算。
const store = require('./store');

const ENGINE_VERSION = 'coldlib-2026.1';

// 参与放行判定的口径参数（改这些字段就会改变判定结果，快照必须冻结）
const SETTING_FIELDS = [
  'lowerLimitC',
  'upperLimitC',
  'allowExcursionMinutes',
  'allowTotalExcursionMinutes',
  'chainGapMinutes',
  'recordIntervalMinutes',
  'mktActivationEnergy',
  'gasConstant',
  'probeCalibrationGraceDays',
];

function toDate(text) {
  return new Date(String(text).replace(' ', 'T') + '+08:00');
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// 快照里只存数字与字符串，这里补回 Date 计算
function minutesBetween(a, b) {
  return Math.round((toDate(b) - toDate(a)) / 60000);
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

// 同一探头同一时刻既有自动记录又有手工更正时，以手工更正为准。
// 输入需按时刻升序；返回 { used, dropped }：used 为实际参与判定的记录，
// dropped 为被替换掉的记录（带 replacedBy，供快照交代“哪些记录没参与、为什么”）。
function pickEffective(rows) {
  const picked = {};
  const dropped = [];
  const order = [];
  for (const row of rows) {
    const key = row.probeId + '|' + row.at;
    const current = picked[key];
    if (!current) {
      picked[key] = row;
      order.push(key);
      continue;
    }
    // 后到的手工更正替换已选的自动记录；反之保留已有手工记录
    if (current.source !== '人工' && row.source === '人工') {
      dropped.push(Object.assign({}, current, { replacedBy: row.id }));
      picked[key] = row;
    } else {
      dropped.push(Object.assign({}, row, { replacedBy: current.id }));
    }
  }
  return { used: order.map((key) => picked[key]), dropped };
}

function effectiveRecords(data, batchId) {
  return pickEffective(recordsOfBatch(data, batchId)).used;
}

// 探头校准有效期（宽限天数也按快照口径取值）
function probeValidOn(probe, day, graceDays) {
  if (!probe || !probe.calibratedUntil) return true;
  let until = String(probe.calibratedUntil);
  const grace = Number(graceDays) || 0;
  if (grace > 0) {
    const d = new Date(until.replace(' ', 'T') + 'T00:00:00+08:00');
    d.setDate(d.getDate() + grace);
    const p = (n) => String(n).padStart(2, '0');
    until = d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
  }
  return String(day) <= until;
}

// 超限段：连续超出上下限的时段，回到范围内即断开。
// 段时长按固定记录间隔逐段累计（每加入一个超限点，累加一个间隔）。
// 返回 { segments, longest, totalMinutes, segmentCount } 以及每个超限点的段序号。
function segmentStats(rows, settings) {
  const lower = num(settings.lowerLimitC);
  const upper = num(settings.upperLimitC);
  const interval = num(settings.recordIntervalMinutes);
  const segments = [];
  const segIndexByPoint = {};
  let current = null;
  rows.forEach((row, idx) => {
    const value = num(row.temperatureC);
    const out = value > upper || value < lower;
    if (out) {
      if (current) {
        current.endAt = row.at;
        current.minutes += interval;
        current.peakC = value > current.peakC ? value : current.peakC;
        current.points += 1;
        current.pointIds.push(row.id);
      } else {
        current = { startAt: row.at, endAt: row.at, minutes: 0, peakC: value, points: 1, pointIds: [row.id] };
        segments.push(current);
      }
      segIndexByPoint[idx] = segments.length - 1;
    } else {
      current = null;
    }
  });
  const longest = segments.reduce((acc, s) => (s.minutes > acc.minutes ? s : acc), { minutes: 0, startAt: '', endAt: '', peakC: 0, points: 0, pointIds: [] });
  const total = segments.reduce((acc, s) => acc + s.minutes, 0);
  return { segments, longest, longestMinutes: longest.minutes, totalMinutes: total, segmentCount: segments.length, segIndexByPoint };
}

function excursionStats(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  const stats = segmentStats(rows, data.settings);
  return Object.assign({}, stats, {
    recordCount: rows.length,
    firstAt: rows.length ? rows[0].at : '',
    lastAt: rows.length ? rows[rows.length - 1].at : '',
  });
}

// 断链：相邻记录（不分探头，按时间线）的时刻差超过门槛
function chainGaps(data, batchId) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batchId);
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const gapMinutes = store.minutesBetween(rows[i - 1].at, rows[i].at);
    if (gapMinutes > num(settings.chainGapMinutes)) {
      gaps.push({
        from: rows[i - 1].at,
        to: rows[i].at,
        fromRecordId: rows[i - 1].id,
        toRecordId: rows[i].id,
        minutes: gapMinutes,
        countedMinutes: num(settings.recordIntervalMinutes),
      });
    }
  }
  return { gaps, gapCount: gaps.length, totalGapMinutes: gaps.reduce((acc, g) => acc + g.countedMinutes, 0) };
}

// MKT：本系统口径为参与记录温度的算术平均（℃，保留两位），
// 活化能/气体常数随快照一并冻结以备口径升级，当前版本不参与算式。
function mktCelsius(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  if (!rows.length) return 0;
  const sum = rows.reduce((acc, row) => acc + num(row.temperatureC), 0);
  return store.round(sum / rows.length, 2);
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

// 累计超限时长：按批次首记录所在月累计
function monthlyExcursionMinutes(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  const firstAt = rows.length ? rows[0].at : '';
  const month = firstAt.slice(0, 7);
  const scoped = rows.filter((r) => String(r.at).slice(0, 7) === month);
  return segmentStats(scoped, data.settings).totalMinutes;
}

// 冻结一份口径参数（只保留会影响判定的字段，全部数值化）
function freezeSettings(settings) {
  const out = {};
  for (const key of SETTING_FIELDS) out[key] = num(settings[key]);
  return out;
}

// 冻结参与判定的探头清单（全量存：既包括用到的，也交代当时在册状态）
function freezeProbes(probes) {
  return (probes || []).map((p) => ({
    id: p.id,
    code: p.code,
    roomId: p.roomId,
    position: p.position,
    status: p.status,
    calibratedUntil: String(p.calibratedUntil || ''),
  }));
}

// 冻结参与判定的原始记录（同一批次的全部原始记录，含被手工更正替换掉的）
function freezeRecords(rows) {
  return (rows || []).map((r) => ({
    id: r.id,
    probeId: r.probeId,
    at: r.at,
    temperatureC: num(r.temperatureC),
    source: r.source,
    operator: String(r.operator || ''),
  }));
}

/* ---------------- 判定引擎（纯函数） ---------------- */

// batch: { id, code, product, loadedAt, ... }
// settings: 完整口径（建议来自 freezeSettings）
// rawRecords: 该批次全部原始记录（可不排序，内部按时刻排序）
// probes: 当时在册探头清单
function evaluate(batch, settings, rawRecords, probes) {
  const s = Object.assign({}, store.DEFAULT_SETTINGS, settings || {});
  const probeList = probes || [];
  const probeMap = {};
  probeList.forEach((p) => { probeMap[p.id] = p; });

  const sorted = (rawRecords || []).slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const picked = pickEffective(sorted);
  const rows = picked.used;

  // 逐条取值
  const lower = num(s.lowerLimitC);
  const upper = num(s.upperLimitC);
  const interval = num(s.recordIntervalMinutes);
  const chainThreshold = num(s.chainGapMinutes);
  const seg = segmentStats(rows, s);
  const gapByToId = {};
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const gapMinutes = minutesBetween(rows[i - 1].at, rows[i].at);
    if (gapMinutes > chainThreshold) {
      const g = {
        index: gaps.length + 1,
        from: rows[i - 1].at,
        to: rows[i].at,
        fromRecordId: rows[i - 1].id,
        toRecordId: rows[i].id,
        minutes: gapMinutes,
        countedMinutes: interval,
        thresholdMinutes: chainThreshold,
      };
      gaps.push(g);
      gapByToId[rows[i].id] = g;
    }
  }

  const rowEvals = rows.map((row, idx) => {
    const value = num(row.temperatureC);
    const out = value > upper || value < lower;
    const segIdx = seg.segIndexByPoint[idx];
    const probe = probeMap[row.probeId] || null;
    const day = String(row.at).slice(0, 10);
    const probeValid = probeValidOn(probe, day, s.probeCalibrationGraceDays);
    const gapBefore = gapByToId[row.id] || null;
    return {
      id: row.id,
      probeId: row.probeId,
      probeCode: probe ? probe.code : '',
      at: row.at,
      temperatureC: value,
      source: row.source,
      inBand: !out,
      outOfRange: out,
      lowerLimitC: lower,
      upperLimitC: upper,
      segmentIndex: out && segIdx !== undefined ? segIdx + 1 : null,
      // 该点作为超限段的后续点时，向前累加一个记录间隔；段起点累计 0
      segmentMinutesAdded: out && segIdx !== undefined && seg.segments[segIdx].pointIds[0] !== row.id ? interval : 0,
      gapMinutesBefore: gapBefore ? gapBefore.minutes : null,
      gapThresholdMinutes: gapBefore ? gapBefore.thresholdMinutes : null,
      chainGap: !!gapBefore,
      probeCalibrated: probeValid,
      probeCalibratedUntil: probe ? String(probe.calibratedUntil || '') : '',
      probeMissing: !probe,
    };
  });

  const month = rows.length ? String(rows[0].at).slice(0, 7) : '';
  const accumulated = seg.totalMinutes;
  const mkt = rows.length
    ? store.round(rows.reduce((acc, r) => acc + num(r.temperatureC), 0) / rows.length, 2)
    : 0;

  const expired = [];
  rows.forEach((row) => {
    const probe = probeMap[row.probeId];
    if (!probe) return;
    if (!probeValidOn(probe, String(row.at).slice(0, 10), s.probeCalibrationGraceDays)) {
      if (!expired.some((b) => b.probeId === probe.id)) {
        expired.push({
          probeId: probe.id,
          probeCode: probe.code,
          calibratedUntil: String(probe.calibratedUntil || ''),
          firstAt: row.at,
          recordIds: rows.filter((r) => r.probeId === probe.id && !probeValidOn(probe, String(r.at).slice(0, 10), s.probeCalibrationGraceDays)).map((r) => r.id),
        });
      }
    }
  });

  const segDetails = seg.segments.map((sg, i) => ({
    index: i + 1,
    startAt: sg.startAt,
    endAt: sg.endAt,
    minutes: sg.minutes,
    peakC: sg.peakC,
    points: sg.points,
    recordIds: sg.pointIds.slice(),
  }));

  const allowSingle = num(s.allowExcursionMinutes);
  const allowTotal = num(s.allowTotalExcursionMinutes);
  const conditions = [
    {
      key: 'longest',
      name: '最长超限',
      ok: seg.longestMinutes <= allowSingle,
      value: seg.longestMinutes,
      unit: '分钟',
      limit: allowSingle,
      operator: '<=',
      text: '单次连续超限不超过 ' + allowSingle + ' 分钟',
      basis: seg.segmentCount
        ? '共识别 ' + seg.segmentCount + ' 段超限，最长一段 ' + seg.longestMinutes + ' 分钟（' + seg.longest.startAt + ' 至 ' + seg.longest.endAt + '，峰值 ' + seg.longest.peakC + '℃，' + seg.longest.points + ' 个点），阈值 ' + allowSingle + ' 分钟'
        : '没有识别到超限段，最长超限 0 分钟，阈值 ' + allowSingle + ' 分钟',
      evidenceRecordIds: seg.longest.pointIds ? seg.longest.pointIds.slice() : [],
    },
    {
      key: 'total',
      name: '累计超限',
      ok: accumulated <= allowTotal,
      value: accumulated,
      unit: '分钟',
      limit: allowTotal,
      operator: '<=',
      text: '累计超限不超过 ' + allowTotal + ' 分钟',
      basis: '按首记录所在月（' + (month || '—') + '）累计 ' + seg.segmentCount + ' 段超限，共 ' + accumulated + ' 分钟，阈值 ' + allowTotal + ' 分钟',
      evidenceRecordIds: segDetails.reduce((acc, sg) => acc.concat(sg.recordIds), []),
    },
    {
      key: 'chain',
      name: '断链',
      ok: gaps.length === 0,
      value: gaps.length,
      unit: '处',
      limit: 0,
      operator: '===',
      text: '全程没有断链',
      basis: gaps.length
        ? '相邻记录间隔超过 ' + chainThreshold + ' 分钟的缺口有 ' + gaps.length + ' 处：' + gaps.map((g) => g.from + '→' + g.to + '（' + g.minutes + ' 分钟）').join('；')
        : '相邻记录间隔均不超过 ' + chainThreshold + ' 分钟，没有断链',
      evidenceRecordIds: gaps.reduce((acc, g) => acc.concat([g.fromRecordId, g.toRecordId]), []),
    },
    {
      key: 'calibration',
      name: '探头校准',
      ok: expired.length === 0,
      value: expired.length,
      unit: '个',
      limit: 0,
      operator: '===',
      text: '参与判定的探头都在校准有效期内',
      basis: expired.length
        ? '有 ' + expired.length + ' 个探头在记录时刻已超出校准有效期：' + expired.map((p) => p.probeCode + '（有效期至 ' + p.calibratedUntil + '，最早见于 ' + p.firstAt + '）').join('；')
        : '参与判定的 ' + new Set(rows.map((r) => r.probeId)).size + ' 个探头在各自记录时刻均在校准有效期内',
      evidenceRecordIds: expired.reduce((acc, p) => acc.concat(p.recordIds), []),
    },
  ];

  return {
    engineVersion: ENGINE_VERSION,
    settings: freezeSettings(s),
    batch: {
      id: batch.id,
      code: batch.code || '',
      product: batch.product || '',
      loadedAt: batch.loadedAt || '',
    },
    recordCount: rows.length,
    droppedCount: picked.dropped.length,
    firstAt: rows.length ? rows[0].at : '',
    lastAt: rows.length ? rows[rows.length - 1].at : '',
    monthScope: month,
    rows: rowEvals,
    droppedRecords: picked.dropped.map((r) => ({
      id: r.id, probeId: r.probeId, at: r.at, temperatureC: num(r.temperatureC), source: r.source, replacedBy: r.replacedBy,
    })),
    segments: segDetails,
    chainGaps: gaps,
    expiredProbes: expired,
    mkt,
    longestMinutes: seg.longestMinutes,
    totalMinutes: accumulated,
    chainGapCount: gaps.length,
    conditions,
    pass: conditions.every((c) => c.ok),
    failed: conditions.filter((c) => !c.ok).map((c) => c.key),
  };
}

// 供旧接口/页面使用：基于实时数据出一份评估
function evaluateData(data, batch) {
  const raw = data.records.filter((r) => r.batchId === batch.id);
  return evaluate(batch, data.settings, raw, data.probes);
}

// 旧版放行判定结构（页面 decorator 与 /release-check 仍在用），字段映射自评估结果
function releaseCheck(data, batch) {
  const ev = evaluateData(data, batch);
  return {
    mkt: ev.mkt,
    longestMinutes: ev.longestMinutes,
    totalMinutes: ev.totalMinutes,
    recordCount: ev.recordCount,
    firstAt: ev.firstAt,
    lastAt: ev.lastAt,
    chain: {
      gaps: ev.chainGaps.map((g) => ({ from: g.from, to: g.to, minutes: g.minutes, countedMinutes: g.countedMinutes })),
      gapCount: ev.chainGapCount,
      totalGapMinutes: ev.chainGaps.reduce((acc, g) => acc + g.countedMinutes, 0),
    },
    expiredProbes: ev.expiredProbes.map((p) => ({ probeId: p.probeId, probeCode: p.probeCode, calibratedUntil: p.calibratedUntil, at: p.firstAt })),
    conditions: ev.conditions
      .filter((c) => c.key !== 'calibration')
      .map((c) => ({ key: c.key, ok: c.ok, value: c.value, limit: c.limit, text: c.text })),
    pass: ev.pass,
    failed: ev.failed.slice(),
  };
}

function accumulatedExcursionMinutes(data, batchId) {
  return excursionStats(data, batchId).totalMinutes;
}

module.exports = {
  ENGINE_VERSION,
  SETTING_FIELDS,
  toDate,
  probeOf,
  recordsOfBatch,
  pickEffective,
  effectiveRecords,
  excursionStats,
  chainGaps,
  mktCelsius,
  probeValidOn,
  expiredProbes,
  accumulatedExcursionMinutes,
  monthlyExcursionMinutes,
  freezeSettings,
  freezeProbes,
  freezeRecords,
  evaluate,
  evaluateData,
  releaseCheck,
};
