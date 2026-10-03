// 决策快照与复算。
// 每次放行/拒收都把「当时的口径参数、探头清单、参与判定的记录及逐条取值、
// 四条判据的结论与依据」固化成一份快照；之后可以：
//   replay  —— 只用快照里的输入重算，应得到与单子完全一致的结论（可复算）；
//   recheck —— 用当前口径/探头/记录重算一份「如果现在判会怎样」，并逐判据归因差异。
const { AppError } = require('./errors');
const store = require('./store');
const coldlib = require('./coldlib');

const COND_LABEL = {
  longest: '单次连续超限',
  total: '累计超限',
  chain: '断链',
  calibration: '探头校准',
};
const COND_ORDER = ['longest', 'total', 'chain', 'calibration'];

const PARAM_LABEL = {
  lowerLimitC: '温度带下限',
  upperLimitC: '温度带上限',
  allowExcursionMinutes: '单次允许超限(分钟)',
  allowTotalExcursionMinutes: '累计允许超限(分钟)',
  chainGapMinutes: '断链门槛(分钟)',
  recordIntervalMinutes: '记录间隔(分钟)',
  probeCalibrationGraceDays: '校准宽限天数',
  mktActivationEnergy: 'MKT 活化能',
  gasConstant: '气体常数',
};

// 每条判据实际依赖哪些口径参数
const COND_PARAMS = {
  longest: ['lowerLimitC', 'upperLimitC', 'allowExcursionMinutes', 'recordIntervalMinutes'],
  total: ['lowerLimitC', 'upperLimitC', 'allowTotalExcursionMinutes', 'recordIntervalMinutes'],
  chain: ['chainGapMinutes'],
  calibration: ['probeCalibrationGraceDays'],
};

function makeSnapshot(data, batch, release) {
  const rows = coldlib.effectiveRecords(data, batch.id);
  const involved = {};
  rows.forEach((r) => { involved[r.probeId] = true; });
  const probes = data.probes.filter((p) => involved[p.id]).map((p) => Object.assign({}, p));
  const result = coldlib.evaluate(rows, probes, data.settings);
  return {
    id: store.nextId('sn', data.snapshots),
    batchId: batch.id,
    batchCode: batch.code,
    releaseId: release.id,
    decision: release.decision,
    decidedAt: release.decidedAt,
    decider: release.decider,
    basis: release.basis,
    remark: release.remark,
    calcVersion: coldlib.CALC_VERSION,
    settings: coldlib.frozenSettings(data.settings),
    probesInvolved: probes,
    // 参与判定的记录：已按「同探头同时刻以手工为准」去重，逐条取值冻结在 result.records
    records: rows.map((r) => ({
      id: r.id, probeId: r.probeId, at: r.at,
      temperatureC: Number(r.temperatureC), source: r.source,
      operator: r.operator || '', remark: r.remark || '',
    })),
    result: result,
  };
}

function getSnapshot(data, id) {
  const snap = data.snapshots.find((x) => x.id === id);
  if (!snap) throw new AppError(404, 'SNAPSHOT_NOT_FOUND', '这份判定快照不存在');
  return snap;
}

function condMap(result) {
  const map = {};
  (result.conditions || []).forEach((c) => { map[c.key] = c; });
  return map;
}

function condBrief(result) {
  return COND_ORDER.map((key) => {
    const c = (result.conditions || []).find((x) => x.key === key);
    return { key: key, label: COND_LABEL[key], ok: c.ok, value: c.value, limit: c.limit, text: c.text };
  });
}

// 按快照复算：输入全部取自快照，与当前数据库无关
function replaySnapshot(data, id) {
  const snap = getSnapshot(data, id);
  const replay = coldlib.evaluate(snap.records, snap.probesInvolved, snap.settings);
  const storedMap = condMap(snap.result);
  const replayMap = condMap(replay);
  const matches = COND_ORDER.every((key) => {
    const a = storedMap[key];
    const b = replayMap[key];
    return a && b && a.ok === b.ok && Number(a.value) === Number(b.value);
  }) && snap.result.pass === replay.pass;
  return {
    snapshotId: snap.id,
    consistent: matches,
    stored: { pass: snap.result.pass, mkt: snap.result.mkt, conditions: condBrief(snap.result) },
    replay: { pass: replay.pass, mkt: replay.mkt, conditions: condBrief(replay) },
  };
}

function diffParams(snap, curSettings) {
  const changes = [];
  for (const key of coldlib.SETTING_KEYS) {
    const from = Number(snap.settings[key]);
    const to = Number(curSettings[key]);
    if (from !== to) changes.push({ key: key, label: PARAM_LABEL[key] || key, from: from, to: to });
  }
  return changes;
}

function diffRecords(snap, curRows) {
  // 以「探头|时刻」为键比较有效记录集合（同一键手工/自动去重后的胜出者）
  const keyOf = (r) => r.probeId + '|' + r.at;
  const before = {};
  const after = {};
  snap.records.forEach((r) => { before[keyOf(r)] = r; });
  curRows.forEach((r) => { after[keyOf(r)] = r; });
  const brief = (r) => r ? { recordId: r.id, temperatureC: Number(r.temperatureC), at: r.at, source: r.source, probeId: r.probeId } : null;
  const changes = [];
  const keys = {};
  Object.keys(before).forEach((k) => { keys[k] = true; });
  Object.keys(after).forEach((k) => { keys[k] = true; });
  Object.keys(keys).sort().forEach((k) => {
    const a = before[k] || null;
    const b = after[k] || null;
    if (a && !b) {
      changes.push({ kind: 'removed', key: k, recordId: a.id, probeId: a.probeId, at: a.at, before: brief(a), after: null });
    } else if (!a && b) {
      changes.push({ kind: 'added', key: k, recordId: b.id, probeId: b.probeId, at: b.at, before: null, after: brief(b) });
    } else if (a.id !== b.id) {
      // 同一探头同一时刻的去重胜出者变了（典型：手工更正被删，自动记录恢复）
      changes.push({ kind: 'replaced', key: k, recordId: b.id, probeId: b.probeId, at: b.at, before: brief(a), after: brief(b) });
    } else if (Number(a.temperatureC) !== Number(b.temperatureC) || a.source !== b.source) {
      changes.push({ kind: 'modified', key: k, recordId: b.id, probeId: b.probeId, at: b.at, before: brief(a), after: brief(b) });
    }
  });
  return changes;
}

function diffProbes(snap, curProbes, curResult) {
  // 只比较「快照时参与过判定」与「当前仍有记录参与判定」的探头，其余探头不参与归因
  const involvedNow = {};
  (curResult.probes || []).forEach((p) => { involvedNow[p.probeId] = true; });
  const involvedThen = {};
  snap.probesInvolved.forEach((p) => { involvedThen[p.id] = true; });

  const before = {};
  const after = {};
  snap.probesInvolved.forEach((p) => { before[p.id] = p; });
  curProbes.forEach((p) => { if (involvedNow[p.id]) after[p.id] = p; });
  // 当前记录仍引用、但探头已从台账删除
  (curResult.probes || []).forEach((p) => { if (after[p.probeId] === undefined) after[p.probeId] = null; });

  const changes = [];
  const ids = {};
  Object.keys(before).forEach((id) => { ids[id] = true; });
  Object.keys(after).forEach((id) => { ids[id] = true; });
  for (const id of Object.keys(ids)) {
    const a = before[id] || null;
    const b = after[id] || null;
    if (!a && involvedNow[id]) {
      changes.push({ probeId: id, kind: 'added', before: null, after: b ? { code: b.code, status: b.status, calibratedUntil: b.calibratedUntil } : { code: id, status: '探头已不在清单', calibratedUntil: '' } });
    } else if (a && !b) {
      changes.push({ probeId: id, kind: 'removed', before: { code: a.code, status: a.status, calibratedUntil: a.calibratedUntil }, after: null });
    } else if (a && b && (a.status !== b.status || String(a.calibratedUntil) !== String(b.calibratedUntil))) {
      changes.push({ probeId: id, kind: 'modified',
        before: { code: a.code, status: a.status, calibratedUntil: a.calibratedUntil },
        after: { code: b.code, status: b.status, calibratedUntil: b.calibratedUntil } });
    }
  }
  return changes;
}

// 逐条记录变化与某条判据是否相关
function changeRelevantTo(key, change) {
  if (key === 'calibration') {
    // 探头判据由探头清单变化解释（见 probeChanges），记录本身不参与
    return false;
  }
  if (key === 'chain') {
    // 断链只看时刻差：增删记录、改时刻/探头相关，只改温度不相关
    if (change.kind === 'added' || change.kind === 'removed') return true;
    return change.before.at !== change.after.at || change.before.probeId !== change.after.probeId;
  }
  // longest / total：增删记录，或温度、时刻、来源变化都可能改变超限段
  if (change.kind === 'added' || change.kind === 'removed') return true;
  return Number(change.before.temperatureC) !== Number(change.after.temperatureC) ||
    change.before.at !== change.after.at || change.before.source !== change.after.source;
}

function gapKey(g) {
  return g.probeId + '|' + g.from + '|' + g.to;
}

function diffOneCondition(key, snap, curResult, paramChanges, recordChanges, probeChanges) {
  const stored = (snap.result.conditions || []).find((c) => c.key === key);
  const current = (curResult.conditions || []).find((c) => c.key === key);
  const valueDelta = Number(current.value) - Number(stored.value);
  const okChanged = stored.ok !== current.ok;

  const relevantParams = paramChanges.filter((p) => COND_PARAMS[key].indexOf(p.key) >= 0);
  const relevantRecords = recordChanges.filter((c) => changeRelevantTo(key, c));
  const relevantProbes = key === 'calibration' ? probeChanges : [];

  let status;
  if (okChanged) status = '结论翻转';
  else if (valueDelta !== 0) status = '数值变化';
  else if (relevantParams.length || relevantProbes.length) status = '口径变化';
  else status = '一致';

  const detail = {};
  if (key === 'chain') {
    const beforeKeys = {};
    const afterKeys = {};
    (stored.basis.gaps || []).forEach((g) => { beforeKeys[gapKey(g)] = g; });
    (current.basis.gaps || []).forEach((g) => { afterKeys[gapKey(g)] = g; });
    detail.newGaps = Object.keys(afterKeys).filter((k) => !beforeKeys[k]).map((k) => afterKeys[k]);
    detail.goneGaps = Object.keys(beforeKeys).filter((k) => !afterKeys[k]).map((k) => beforeKeys[k]);
  }

  return {
    key: key,
    label: COND_LABEL[key],
    status: status,
    storedOk: stored.ok,
    currentOk: current.ok,
    storedValue: stored.value,
    currentValue: current.value,
    storedLimit: stored.limit,
    currentLimit: current.limit,
    valueDelta: valueDelta,
    storedText: stored.text,
    currentText: current.text,
    paramChanges: relevantParams,
    recordChanges: relevantRecords,
    probeChanges: relevantProbes,
    detail: detail,
  };
}

// 按当前口径重算并逐判据归因
function recheckSnapshot(data, id) {
  const snap = getSnapshot(data, id);
  const batch = data.batches.find((b) => b.id === snap.batchId);
  const curRows = batch ? coldlib.effectiveRecords(data, batch.id) : [];
  const curResult = coldlib.evaluate(curRows, data.probes, data.settings);

  const paramChanges = diffParams(snap, data.settings);
  const recordChanges = diffRecords(snap, curRows);
  const probeChanges = diffProbes(snap, data.probes, curResult);

  const conditionDiffs = COND_ORDER.map((key) =>
    diffOneCondition(key, snap, curResult, paramChanges, recordChanges, probeChanges));

  const consistent = snap.result.pass === curResult.pass &&
    conditionDiffs.every((d) => d.status === '一致');

  // 若快照算法版本升级，单独提示
  const versionChanged = snap.calcVersion !== coldlib.CALC_VERSION;

  return {
    snapshotId: snap.id,
    batchExists: !!batch,
    consistent: consistent,
    versionChanged: versionChanged,
    calcVersion: { from: snap.calcVersion, to: coldlib.CALC_VERSION },
    stored: { pass: snap.result.pass, mkt: snap.result.mkt, conditions: condBrief(snap.result) },
    current: { pass: curResult.pass, mkt: curResult.mkt, conditions: condBrief(curResult), recordCount: curResult.recordCount },
    paramChanges: paramChanges,
    recordChanges: recordChanges,
    probeChanges: probeChanges,
    conditionDiffs: conditionDiffs,
  };
}

module.exports = {
  makeSnapshot,
  getSnapshot,
  replaySnapshot,
  recheckSnapshot,
  COND_LABEL,
  COND_ORDER,
  PARAM_LABEL,
};
