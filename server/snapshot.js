// 决策快照：每次放行/拒收冻结当时的口径参数、探头清单、批次原始记录与逐条判定依据，
// 并提供三种用法：
//   replay    —— 只用快照里冻结的输入，用同一版本引擎原样复算，核对与单子结论是否一致；
//   recompute —— 用当前口径/记录/探头重算“如果现在判会怎样”，并逐条给出差异与成因；
//   backfill —— 为没有快照的历史放行单补建（标记为参数系推断，仅供参考）。
const store = require('./store');
const coldlib = require('./coldlib');

const SNAPSHOT_VERSION = 1;

// 判据依赖哪些口径参数（差异归因用）
const CONDITION_PARAMS = {
  longest: ['lowerLimitC', 'upperLimitC', 'allowExcursionMinutes', 'recordIntervalMinutes'],
  total: ['lowerLimitC', 'upperLimitC', 'allowTotalExcursionMinutes', 'recordIntervalMinutes'],
  chain: ['chainGapMinutes', 'recordIntervalMinutes'],
  calibration: ['probeCalibrationGraceDays'],
};

const PARAM_LABELS = {
  lowerLimitC: '温度带下限(℃)',
  upperLimitC: '温度带上限(℃)',
  allowExcursionMinutes: '单次允许超限(分钟)',
  allowTotalExcursionMinutes: '累计允许超限(分钟)',
  chainGapMinutes: '断链门槛(分钟)',
  recordIntervalMinutes: '记录间隔(分钟)',
  mktActivationEnergy: 'MKT 活化能',
  gasConstant: '气体常数',
  probeCalibrationGraceDays: '探头校准宽限天数',
};

// 构建并落库一份快照
function createSnapshot(data, batch, release, extra) {
  const settings = coldlib.freezeSettings(data.settings);
  const probes = coldlib.freezeProbes(data.probes);
  const records = coldlib.freezeRecords(data.records.filter((r) => r.batchId === batch.id));
  const result = coldlib.evaluate(batch, settings, records, probes);
  const snapshot = {
    id: store.nextId('snap', data.snapshots),
    snapshotVersion: SNAPSHOT_VERSION,
    kind: 'release-decision',
    origin: (extra && extra.origin) || 'decision',
    parametersAssumed: !!(extra && extra.parametersAssumed),
    engineVersion: result.engineVersion,
    createdAt: store.nowText(),
    batchId: batch.id,
    releaseId: release.id,
    release: {
      id: release.id,
      decision: release.decision,
      decidedAt: release.decidedAt,
      decider: release.decider,
      basis: release.basis || '',
      remark: release.remark || '',
      // 单子上印的四个数，复算时一并核对
      printed: {
        mkt: release.mkt,
        longestExcursionMinutes: release.longestExcursionMinutes,
        totalExcursionMinutes: release.totalExcursionMinutes,
        chainGapCount: release.chainGapCount,
      },
    },
    batch: result.batch,
    settings,
    probes,
    records,
    result,
  };
  data.snapshots.push(snapshot);
  return snapshot;
}

function getSnapshot(data, releaseId) {
  return data.snapshots.find((s) => s.releaseId === releaseId) || null;
}

function getById(data, snapshotId) {
  return data.snapshots.find((s) => s.id === snapshotId) || null;
}

/* ---------------- 按快照复算 ---------------- */

function canonical(ev) {
  return {
    engineVersion: ev.engineVersion,
    recordCount: ev.recordCount,
    droppedCount: ev.droppedCount,
    mkt: ev.mkt,
    longestMinutes: ev.longestMinutes,
    totalMinutes: ev.totalMinutes,
    chainGapCount: ev.chainGapCount,
    pass: ev.pass,
    failed: ev.failed.slice(),
    conditions: ev.conditions.map((c) => ({ key: c.key, ok: c.ok, value: c.value, limit: c.limit })),
    segments: ev.segments.map((g) => ({ startAt: g.startAt, endAt: g.endAt, minutes: g.minutes, peakC: g.peakC, points: g.points })),
    chainGaps: ev.chainGaps.map((g) => ({ from: g.from, to: g.to, minutes: g.minutes })),
  };
}

function diffCanonical(a, b, path) {
  const out = [];
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push({ path: path + '.length', stored: a.length, replayed: b.length });
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i += 1) out.push.apply(out, diffCanonical(a[i], b[i], path + '[' + i + ']'));
    return out;
  }
  if (a && b && typeof a === 'object') {
    Object.keys(a).forEach((k) => { out.push.apply(out, diffCanonical(a[k], b[k], path ? path + '.' + k : k)); });
    return out;
  }
  if (a !== b) out.push({ path: path || '', stored: a, replayed: b });
  return out;
}

// 用快照冻结的输入原样复算（不读当前库），并核对单子上印的数
function replay(snapshot) {
  const replayed = coldlib.evaluate(snapshot.batch, snapshot.settings, snapshot.records, snapshot.probes);
  const mismatches = diffCanonical(canonical(snapshot.result), canonical(replayed), '');
  const printed = snapshot.release.printed || {};
  const printedMismatches = [];
  const printedPairs = [
    ['mkt', replayed.mkt],
    ['longestExcursionMinutes', replayed.longestMinutes],
    ['totalExcursionMinutes', replayed.totalMinutes],
    ['chainGapCount', replayed.chainGapCount],
  ];
  printedPairs.forEach(([key, value]) => {
    if (Number(printed[key]) !== Number(value)) {
      printedMismatches.push({ field: key, printed: printed[key], replayed: value });
    }
  });
  return {
    engineVersion: coldlib.ENGINE_VERSION,
    snapshotEngineVersion: snapshot.engineVersion,
    consistent: mismatches.length === 0,
    printedConsistent: printedMismatches.length === 0,
    mismatches,
    printedMismatches,
    result: replayed,
  };
}

/* ---------------- 按当前口径重算与差异归因 ---------------- */

function compareSettings(frozen, current) {
  const out = [];
  coldlib.SETTING_FIELDS.forEach((key) => {
    const a = Number(frozen[key]);
    const b = Number(current[key]);
    if (a !== b) {
      out.push({ field: key, label: PARAM_LABELS[key] || key, snapshotValue: a, currentValue: b, delta: store.round(b - a, 4) });
    }
  });
  return out;
}

function compareRecords(frozen, current) {
  const aMap = {};
  const bMap = {};
  frozen.forEach((r) => { aMap[r.id] = r; });
  (current || []).forEach((r) => { bMap[r.id] = r; });
  const added = [];
  const removed = [];
  const changed = [];
  Object.keys(bMap).forEach((id) => {
    if (!aMap[id]) added.push(bMap[id]);
  });
  Object.keys(aMap).forEach((id) => {
    const a = aMap[id];
    const b = bMap[id];
    if (!b) {
      removed.push(a);
      return;
    }
    const fields = {};
    if (Number(a.temperatureC) !== Number(b.temperatureC)) fields.temperatureC = { snapshotValue: Number(a.temperatureC), currentValue: Number(b.temperatureC) };
    if (String(a.source) !== String(b.source)) fields.source = { snapshotValue: a.source, currentValue: b.source };
    if (String(a.at) !== String(b.at)) fields.at = { snapshotValue: a.at, currentValue: b.at };
    if (String(a.probeId) !== String(b.probeId)) fields.probeId = { snapshotValue: a.probeId, currentValue: b.probeId };
    if (Object.keys(fields).length) changed.push({ id: id, at: b.at || a.at, probeId: b.probeId || a.probeId, fields: fields });
  });
  return { added: added, removed: removed, changed: changed };
}

function compareProbes(frozen, current, recordIdsNow, recordIdsThen) {
  const usedIds = {};
  Object.keys(recordIdsThen || {}).forEach((pid) => { usedIds[pid] = true; });
  Object.keys(recordIdsNow || {}).forEach((pid) => { usedIds[pid] = true; });
  const aMap = {};
  const bMap = {};
  frozen.forEach((p) => { aMap[p.id] = p; });
  (current || []).forEach((p) => { bMap[p.id] = p; });
  const out = [];
  Object.keys(usedIds).forEach((pid) => {
    const a = aMap[pid];
    const b = bMap[pid];
    if (!a && b) { out.push({ probeId: pid, probeCode: b.code, change: 'added', snapshotValue: null, currentValue: '在册（' + b.code + '）' }); return; }
    if (a && !b) { out.push({ probeId: pid, probeCode: a.code, change: 'removed', snapshotValue: '在册（' + a.code + '）', currentValue: null }); return; }
    if (!a || !b) return;
    const fields = {};
    if (String(a.calibratedUntil) !== String(b.calibratedUntil)) fields.calibratedUntil = { snapshotValue: a.calibratedUntil, currentValue: b.calibratedUntil };
    if (String(a.status) !== String(b.status)) fields.status = { snapshotValue: a.status, currentValue: b.status };
    if (Object.keys(fields).length) out.push({ probeId: pid, probeCode: a.code, change: 'changed', fields: fields });
  });
  return out;
}

// 用当前库重算，并给出与快照结论的逐条差异
function recompute(data, snapshot) {
  const batch = data.batches.find((b) => b.id === snapshot.batchId) || snapshot.batch;
  const currentRecordsRaw = data.records.filter((r) => r.batchId === snapshot.batchId);
  const current = coldlib.evaluate(batch, data.settings, currentRecordsRaw, data.probes);
  const stored = snapshot.result;

  const settingDiffs = compareSettings(snapshot.settings, coldlib.freezeSettings(data.settings));
  const recordDiffs = compareRecords(snapshot.records, coldlib.freezeRecords(currentRecordsRaw));
  const probeIdsThen = {};
  snapshot.records.forEach((r) => { probeIdsThen[r.probeId] = true; });
  const probeIdsNow = {};
  currentRecordsRaw.forEach((r) => { probeIdsNow[r.probeId] = true; });
  const probeDiffs = compareProbes(snapshot.probes, coldlib.freezeProbes(data.probes), probeIdsNow, probeIdsThen);

  const changedRecordIds = {};
  recordDiffs.added.forEach((r) => { changedRecordIds[r.id] = 'added'; });
  recordDiffs.removed.forEach((r) => { changedRecordIds[r.id] = 'removed'; });
  recordDiffs.changed.forEach((c) => { changedRecordIds[c.id] = 'changed'; });
  const changedParams = {};
  settingDiffs.forEach((d) => { changedParams[d.field] = d; });

  const condA = {};
  stored.conditions.forEach((c) => { condA[c.key] = c; });
  const condB = {};
  current.conditions.forEach((c) => { condB[c.key] = c; });

  const conditionDiffs = Object.keys(condB).map((key) => {
    const a = condA[key];
    const b = condB[key];
    if (!a) return null;
    const involvedParams = (CONDITION_PARAMS[key] || []).filter((p) => changedParams[p]).map((p) => changedParams[p]);
    const evidence = {};
    (a.evidenceRecordIds || []).forEach((id) => { evidence[id] = true; });
    (b.evidenceRecordIds || []).forEach((id) => { evidence[id] = true; });
    const involvedRecords = Object.keys(evidence)
      .filter((id) => changedRecordIds[id])
      .map((id) => ({ id: id, change: changedRecordIds[id] }));
    return {
      key: key,
      name: b.name,
      snapshotOk: a.ok,
      currentOk: b.ok,
      flipped: a.ok !== b.ok,
      snapshotValue: a.value,
      currentValue: b.value,
      valueDelta: store.round(Number(b.value) - Number(a.value), 2),
      snapshotLimit: a.limit,
      currentLimit: b.limit,
      unit: b.unit,
      snapshotBasis: a.basis,
      currentBasis: b.basis,
      parameterCauses: involvedParams,
      recordCauses: involvedRecords,
      probeCauses: key === 'calibration' ? probeDiffs : [],
    };
  }).filter(Boolean);

  return {
    engineVersion: coldlib.ENGINE_VERSION,
    snapshotTakenAt: snapshot.createdAt,
    currentAt: store.nowText(),
    currentSettings: coldlib.freezeSettings(data.settings),
    snapshotPass: stored.pass,
    currentPass: current.pass,
    conclusionFlipped: stored.pass !== current.pass,
    snapshotFailed: stored.failed,
    currentFailed: current.failed,
    mkt: { snapshotValue: stored.mkt, currentValue: current.mkt, delta: store.round(current.mkt - stored.mkt, 2) },
    recordCounts: { snapshot: stored.recordCount, current: current.recordCount, droppedSnapshot: stored.droppedCount, droppedCurrent: current.droppedCount },
    settingDiffs: settingDiffs,
    recordDiffs: {
      added: recordDiffs.added.map((r) => ({ id: r.id, at: r.at, probeId: r.probeId, temperatureC: Number(r.temperatureC), source: r.source })),
      removed: recordDiffs.removed.map((r) => ({ id: r.id, at: r.at, probeId: r.probeId, temperatureC: Number(r.temperatureC), source: r.source })),
      changed: recordDiffs.changed,
    },
    probeDiffs: probeDiffs,
    conditionDiffs: conditionDiffs,
    flippedConditions: conditionDiffs.filter((c) => c.flipped),
    result: current,
  };
}

// 为历史放行单反查补建快照：记录/探头取自当前库，口径允许显式指定，标记为推断
function backfill(data, batch, release, settingsOverride) {
  // 快照写入真实的 data.snapshots；口径可覆盖（历史单只能按当时口径反推时使用）
  const virtualData = {
    settings: Object.assign({}, data.settings, settingsOverride || {}),
    probes: data.probes,
    records: data.records,
    snapshots: data.snapshots,
  };
  return createSnapshot(virtualData, batch, release, { origin: 'backfill', parametersAssumed: true });
}

// 启动时为没有快照的历史单子补建（用当前口径，明确标记为推断）
function backfillMissing(data) {
  const created = [];
  for (const release of data.releases) {
    if (getSnapshot(data, release.id)) continue;
    const batch = data.batches.find((b) => b.id === release.batchId);
    if (!batch) continue;
    created.push(backfill(data, batch, release, null));
  }
  return created;
}

module.exports = {
  SNAPSHOT_VERSION,
  PARAM_LABELS,
  createSnapshot,
  getSnapshot,
  getById,
  replay,
  recompute,
  backfill,
  backfillMissing,
};
